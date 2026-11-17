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

/** The only tools exposed over MCP; anything else is rejected at dispatch. */
const EXPOSED_TOOL_NAMES = new Set([
  'get_windows_and_tabs',
  'chrome_navigate',
  'chrome_screenshot',
  'chrome_read_page',
  'chrome_click_element',
  'chrome_fill_or_select',
  'chrome_keyboard',
  'chrome_computer',
  'chrome_get_web_content',
  'chrome_switch_tab',
  'chrome_close_tabs',
  'chrome_control_session',
]);

/** Tools that attach the debugger even when they only read. */
const DEBUGGER_TOOLS = new Set(['chrome_screenshot', 'chrome_computer']);

/** Tools whose effects are worth auditing (writes plus navigation). */
const AUDIT_TOOLS = new Set([
  ...WRITE_TOOLS,
  'chrome_navigate',
  'chrome_switch_tab',
  'chrome_close_tabs',
]);

/** Serialize audit writes so concurrent tabs cannot lose entries. */
let auditChain: Promise<void> = Promise.resolve();
function queueAudit(entry: AuditEntry): void {
  auditChain = auditChain
    .catch(() => undefined)
    .then(() => appendAudit(entry))
    .catch(() => undefined);
}

/** Tools that only read state; allowed for any MCP session. */
const READONLY_TOOLS = new Set([
  'get_windows_and_tabs',
  'chrome_read_page',
  'chrome_screenshot',
  'chrome_get_web_content',
]);

/** control_session is only readonly for status/audit; policy mutates state. */
function isReadonlyCall(name: string, args: any): boolean {
  if (name === 'chrome_control_session') {
    const action = String((args && args.action) || 'status');
    return action === 'status' || action === 'audit';
  }
  return READONLY_TOOLS.has(name);
}

/** begin must bypass the ownership gate so a stale owner can be challenged. */
function isBeginCall(name: string, args: any): boolean {
  if (name !== 'chrome_control_session') return false;
  return String((args && args.action) || 'status') === 'begin';
}

/** begin/end must stay callable while suspended, otherwise recovery is impossible. */
function isSessionControl(name: string, args: any): boolean {
  if (name !== 'chrome_control_session') return false;
  const action = String((args && args.action) || 'status');
  return action === 'begin' || action === 'end';
}

const tabLocks = new Map<number, Promise<unknown>>();

// ---- Foreground guard -------------------------------------------------------
// A page may open its own tabs (target=_blank / window.open). Chromium activates
// those, which yanks the user's foreground away even though the agent asked for
// background behaviour. While a write action runs, any tab the page creates is
// pushed back to the background and the previously active tab is restored.
let guardDepth = 0;
const guardPrevActive = new Map<number, number>();
let guardTimer: ReturnType<typeof setTimeout> | null = null;
let guardTargetTabId: number | null = null;

function onGuardedTabCreated(tab: chrome.tabs.Tab): void {
  if (tab.id === undefined || tab.windowId === undefined) return;
  if (guardTargetTabId !== null && tab.openerTabId !== undefined && tab.openerTabId !== guardTargetTabId) {
    return;
  }
  const newTabId = tab.id;
  const windowId = tab.windowId;
  setTimeout(async () => {
    try {
      const created = await chrome.tabs.get(newTabId);
      if (!created.active) return;
      const previous = guardPrevActive.get(windowId);
      await chrome.tabs.update(newTabId, { active: false });
      if (previous !== undefined) {
        try {
          await chrome.tabs.update(previous, { active: true });
        } catch {
          // the user may have closed it meanwhile
        }
      }
    } catch {
      // tab already gone
    }
  }, 60);
}

async function beginForegroundGuard(targetTabId?: number): Promise<void> {
  guardTargetTabId = typeof targetTabId === 'number' ? targetTabId : null;
  if (guardDepth === 0) {
    try {
      const activeTabs = await chrome.tabs.query({ active: true });
      guardPrevActive.clear();
      for (const tab of activeTabs) {
        if (tab.id !== undefined && tab.windowId !== undefined) {
          guardPrevActive.set(tab.windowId, tab.id);
        }
      }
      chrome.tabs.onCreated.addListener(onGuardedTabCreated);
    } catch {
      // best effort
    }
  }
  guardDepth += 1;
  if (guardTimer) clearTimeout(guardTimer);
  // Keep listening briefly after the action so late window.open still gets caught.
  guardTimer = setTimeout(() => {
    void endForegroundGuard();
  }, 8000);
}

async function endForegroundGuard(): Promise<void> {
  if (guardDepth === 0) return;
  guardDepth -= 1;
  if (guardDepth > 0) return;
  try {
    chrome.tabs.onCreated.removeListener(onGuardedTabCreated);
  } catch {
    // ignore
  }
  if (guardTimer) {
    clearTimeout(guardTimer);
    guardTimer = null;
  }
}

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
    if (!EXPOSED_TOOL_NAMES.has(param.name)) {
      return createErrorResponse('E_TOOL_NOT_EXPOSED: ' + param.name + ' is not available over MCP.');
    }
    const sessionId = (param as any).sessionId || '';
    setActiveOwner(sessionId);

    const owner = getSessionOwner();
    const readonly = isReadonlyCall(param.name, param.args);
    // Ownership: a session that does not own the control session may only read.
    const beginExempt = isBeginCall(param.name, param.args) && !!sessionId;
    if (owner && !readonly && !beginExempt && owner !== sessionId) {
      return createErrorResponse(
        'E_SESSION_NOT_OWNER: browser control is owned by another agent session (' + owner + ').',
      );
    }
    // The user canceled debugging: hold every session until someone begins again.
    if (!readonly && !isSessionControl(param.name, param.args) && isSuspendedFor(sessionId)) {
      return createErrorResponse(
        'E_SESSION_SUSPENDED: the user canceled browser debugging. Ask the user to re-approve, then call control_session begin again.',
      );
    }

    // A screenshot still attaches the debugger, which would resurrect the bar
    // the user just dismissed.
    if (!readonly && DEBUGGER_TOOLS.has(param.name) && isSuspendedFor(sessionId)) {
      return createErrorResponse(
        'E_SESSION_SUSPENDED: the user canceled browser debugging; screenshots are paused too.',
      );
    }

    const blocked = await guardWritePolicy(param.name, param.args);
    if (blocked) {
      if (AUDIT_TOOLS.has(param.name)) {
        const blockedTab = param.args && param.args.tabId;
        queueAudit({
          ts: Date.now(),
          session: sessionId,
          tool: param.name,
          tabId: typeof blockedTab === 'number' ? blockedTab : null,
          origin: '',
          method: 'blocked',
          confirmed: false,
        });
      }
      return createErrorResponse(blocked);
    }

    // Only a valid, non-suspended owner refreshes the lease; rejected calls must
    // not keep a vanished owner's claim alive.
    touchActivity(sessionId);

    const tabId = param.args && param.args.tabId;
    const run = () => tool.execute(param.args);
    const guarded = WRITE_TOOLS.has(param.name) || param.name === 'chrome_navigate';
    if (guarded) await beginForegroundGuard(typeof tabId === 'number' ? tabId : undefined);
    let result: any;
    try {
      result = WRITE_TOOLS.has(param.name) && typeof tabId === 'number' ? await withTabLock(tabId, run) : await run();
    } catch (execError: any) {
      if (AUDIT_TOOLS.has(param.name)) {
        queueAudit({
          ts: Date.now(),
          session: sessionId,
          tool: param.name,
          tabId: typeof tabId === 'number' ? tabId : null,
          origin: '',
          method: 'failed',
          confirmed: false,
        });
      }
      throw execError;
    } finally {
      if (guarded) void endForegroundGuard();
    }

    if (AUDIT_TOOLS.has(param.name)) {
      let url = '';
      if (typeof tabId === 'number') {
        try {
          url = (await chrome.tabs.get(tabId)).url || '';
        } catch {
          // tab gone
        }
      }
      queueAudit({
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
