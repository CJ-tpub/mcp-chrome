import { createErrorResponse } from '@/common/tool-handler';
import { ERROR_MESSAGES } from '@/common/constants';
import * as browserTools from './browser';
import { flowRunTool, listPublishedFlowsTool } from './record-replay';
import { ensurePinned, setActiveOwner, touchActivity } from './browser/control-session';

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

const tabLocks = new Map<number, Promise<unknown>>();

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

async function sensitiveSiteBlocks(name: string, args: any): Promise<string | null> {
  if (!WRITE_TOOLS.has(name)) return null;
  if (args && args.confirm === true) return null;
  const tabId = args && args.tabId;
  if (typeof tabId !== 'number') return null;
  try {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || '';
    if (!url || !SENSITIVE_HOST_RE.test(url)) return null;
    return (
      'E_CONFIRM_REQUIRED: ' +
      name +
      ' targets a sensitive site (' +
      url.split('/').slice(0, 3).join('/') +
      '). Re-issue the call with confirm:true only after the user explicitly approved this specific action.'
    );
  } catch {
    return null;
  }
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
    setActiveOwner((param as any).sessionId || '');
    touchActivity();

    const blocked = await sensitiveSiteBlocks(param.name, param.args);
    if (blocked) return createErrorResponse(blocked);

    const tabId = param.args && param.args.tabId;
    const run = () => tool.execute(param.args);
    const result =
      WRITE_TOOLS.has(param.name) && typeof tabId === 'number' ? await withTabLock(tabId, run) : await run();

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
