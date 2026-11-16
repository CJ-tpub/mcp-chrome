import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';
import {
  ensurePinned,
  setActiveOwner,
  touchActivity,
  getSessionOwner,
  isSuspendedFor,
} from './browser/control-session';

const tools = { ...browserTools, flowRunTool, listPublishedFlowsTool } as any;

/** Tools that change page state; they are serialized per tab and gated on sensitive sites. */
const WRITE_TOOLS = new Set([
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_computer',
]);

/** Domains where an unconfirmed write action is refused (banking / payment / webmail). */
const SENSITIVE_HOST_RE =
  /(^|\.)(bank|banking|alipay|wechatpay|paypal|stripe|checkout|wallet)\.|(^|\.)(mail\.google|outlook\.live|mail\.qq|mail\.163)\./i;

/** Tools that only read state; allowed for any MCP session. */
const READONLY_TOOLS = new Set([
  'get_windows_and_tabs',
  'chrome_read_page',
  'chrome_screenshot',
  'chrome_get_web_content',
  'chrome_control_session',
]);

const tabLocks = new Map<number, Promise<unknown>>();

const AUDIT_KEY = 'dsh.audit';
const POLICY_KEY = 'dsh.policy';

interface AuditEntry {
  ts: number;
  session: string;
  tool: string;
  tabId: number | null;
  origin: string;
  method: string;
  confirmed: boolean;
}

async function readPolicy(): Promise<{ confirmMode: 'narrow' | 'always' | 'off' }> {
  try {
    const got = await chrome.storage.local.get(POLICY_KEY);
    const mode = (got?.[POLICY_KEY]?.confirmMode || 'narrow') as string;
    if (mode === 'always' || mode === 'off' || mode === 'narrow') return { confirmMode: mode };
  } catch {
    // ignore
  }
  return { confirmMode: 'narrow' };
}

async function appendAudit(entry: AuditEntry): Promise<void> {
  try {
    const got = await chrome.storage.local.get(AUDIT_KEY);
    const list = Array.isArray(got?.[AUDIT_KEY]) ? got[AUDIT_KEY] : [];
    list.push(entry);
    while (list.length > 300) list.shift();
    await chrome.storage.local.set({ [AUDIT_KEY]: list });
  } catch {
    // auditing must never break a tool call
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.slice(0, 80);
  }
}

/** Serialize actions on the same tab so clicks/typing never interleave. */
function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const previous = tabLocks.get(tabId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  tabLocks.set(
    tabId,
    next.catch(() => undefined).finally(() => {
      if (tabLocks.get(tabId) === next) tabLocks.delete(tabId);
    }),
  );
  return next;
}

async function guardWritePolicy(name: string, args: any): Promise<string | null> {
  if (!WRITE_TOOLS.has(name)) return null;
  if (args && args.confirm === true) return null;
  const policy = await readPolicy();
  if (policy.confirmMode === 'off') return null;
  const tabId = args && args.tabId;
  let url = '';
  if (typeof tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab.url || '';
    } catch {
      // tab gone: nothing to guard
    }
  }
  const sensitive = !!url && SENSITIVE_HOST_RE.test(url);
  if (policy.confirmMode === 'always' && url) {
    return (
      'E_CONFIRM_REQUIRED: ' +
      name +
      ' is a write action and the extension policy is "always" (set dsh.policy.confirmMode to "narrow" or "off" to relax it).'
    );
  }
  if (!sensitive) return null;
  return (
    'E_CONFIRM_REQUIRED: ' +
    name +
    ' targets a sensitive site (' +
    originOf(url) +
    '). Re-issue with confirm:true only after the user explicitly approved this specific action.'
  );
}
const toolsMap = new Map(Object.values(tools).map((tool: any) => [tool.name, tool]));

/**
 * Tool call parameter interface
 */
export interface ToolCallParam {
  name: string;
  args: any;
}

/**
 * Handle tool execution
 */
export const handleCallTool = async (param: ToolCallParam) => {
  const tool = toolsMap.get(param.name);
  if (!tool) {
    return createErrorResponse(`Tool ${param.name} not found`);
  }

  try {
    const sessionId = (param as any).sessionId || '';
    setActiveOwner(sessionId);

    const owner = getSessionOwner();
    const readonly = READONLY_TOOLS.has(param.name);
    // Ownership: a session that does not own the control session may only read.
    if (owner && !readonly && owner !== sessionId) {
      return createErrorResponse(
        'E_SESSION_NOT_OWNER: browser control is owned by another agent session (' + owner + ').',
      );
    }
    // The user canceled debugging: hold every session until someone begins again.
    if (!readonly && isSuspendedFor(sessionId)) {
      return createErrorResponse(
        'E_SESSION_SUSPENDED: the user canceled browser debugging. Ask the user to re-approve, then call control_session begin again.',
      );
    }

    const blocked = await guardWritePolicy(param.name, param.args);
    if (blocked) return createErrorResponse(blocked);

    // Only a valid, non-suspended owner refreshes the lease; rejected calls must
    // not keep a vanished owner's claim alive.
    touchActivity(sessionId);

    const tabId = param.args && param.args.tabId;
    const run = () => tool.execute(param.args);
    const result =
      WRITE_TOOLS.has(param.name) && typeof tabId === 'number' ? await withTabLock(tabId, run) : await run();

    if (WRITE_TOOLS.has(param.name)) {
      let url = '';
      if (typeof tabId === 'number') {
        try {
          url = (await chrome.tabs.get(tabId)).url || '';
        } catch {
          // tab gone
        }
      }
      void appendAudit({
        ts: Date.now(),
        session: sessionId,
        tool: param.name,
        tabId: typeof tabId === 'number' ? tabId : null,
        origin: url ? originOf(url) : '',
        method: (param.args && param.args.confirm === true ? 'confirmed' : 'auto'),
        confirmed: !!(param.args && param.args.confirm === true),
      });
    }

    // A control session pins every tab the agent actually touches, even when the
    // tool itself never uses the debugger (selector clicks, fills, ...).
    try {
      if (typeof tabId === 'number') void ensurePinned(tabId);
    } catch {
      // pinning must never break a tool result
    }
    return result;
  } catch (error) {
    console.error(`Tool execution failed for ${param.name}:`, error);
    return createErrorResponse(
      error instanceof Error ? error.message : ERROR_MESSAGES.TOOL_EXECUTION_FAILED,
    );
  }
};
