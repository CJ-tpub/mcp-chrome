import { TOOL_NAMES } from 'chrome-mcp-shared';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { installCursor, setFaviconBadge, hideCursor } from '@/utils/page-overlay';

/**
 * Control session: a session-scoped layer over mcp-chrome's per-call CDP usage.
 *
 * Goals (parity with desktop assistants that drive the user's real browser):
 *  1. keep ONE debugger attachment alive per touched tab, so the browser shows a
 *     single steady "is debugging this browser" bar instead of a flicker per call;
 *  2. mark controlled tabs (tab group + action badge + favicon badge);
 *  3. give the page a visible cursor overlay while acting;
 *  4. never bring the tab or its window to the foreground.
 */

export const CONTROL_SESSION_OWNER = 'control-session';
const STATE_KEY = 'dsh.controlSession';
const SUSPEND_KEY = 'dsh.controlSuspended';

export interface ControlSessionPolicy {
  background: boolean;
  group: boolean;
  cursor: boolean;
  favicon: boolean;
}

export interface ControlSessionState {
  sessionId: string;
  /** MCP session that owns this control session. */
  owner: string;
  label: string;
  startedAt: number;
  tabIds: number[];
  policy: ControlSessionPolicy;
}

let current: ControlSessionState | null = null;
const pinned = new Set<number>();
/** MCP session id currently driving this extension (set by the tool dispatcher). */
let activeOwner = '';
/** Set after the user cancels the debug bar; blocks silent auto re-attach. */
let suspendedOwner = '';
let lastActivityAt = 0;
const groupByWindow = new Map<number, number>();

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError: false };
}

function normalizePolicy(partial?: Partial<ControlSessionPolicy>): ControlSessionPolicy {
  return {
    background: partial?.background ?? true,
    group: partial?.group ?? true,
    cursor: partial?.cursor ?? true,
    favicon: partial?.favicon ?? true,
  };
}

export function getControlSession(): ControlSessionState | null {
  return current;
}

export function setActiveOwner(owner: string): void {
  activeOwner = owner || '';
}

export function touchActivity(): void {
  lastActivityAt = Date.now();
}

export function getSessionOwner(): string {
  return current?.owner || '';
}

/** True when the user canceled debugging for this owner and we must not act. */
export function isSuspendedFor(owner: string): boolean {
  return !!owner && suspendedOwner === owner;
}

export function getSuspensionOwner(): string {
  return suspendedOwner;
}

export function isControlSessionActive(): boolean {
  return current !== null;
}

async function persist(): Promise<void> {
  try {
    const storage = chrome.storage.session;
    if (!storage) return;
    if (current) await storage.set({ [STATE_KEY]: current });
    else await storage.remove(STATE_KEY);
  } catch {
    // best effort
  }
}

async function ensureGrouped(tabId: number, label: string): Promise<void> {
  if (!current?.policy.group) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const windowId = tab.windowId;
    let groupId = groupByWindow.get(windowId);
    if (groupId === undefined) {
      groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
      groupByWindow.set(windowId, groupId);
      await chrome.tabGroups.update(groupId, {
        title: 'DSH · ' + label,
        color: 'blue',
        collapsed: false,
      });
    } else {
      await chrome.tabs.group({ tabIds: [tabId], groupId });
    }
  } catch (error) {
    console.warn('[control-session] tab group failed', error);
  }
}

async function ensureMarked(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: 'AI' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#1d4ed8' });
  } catch {
    // action API unavailable on some channels
  }
  if (current?.policy.favicon) await setFaviconBadge(tabId, true);
  if (current?.policy.cursor) await installCursor(tabId);
}

async function unmark(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // ignore
  }
  await setFaviconBadge(tabId, false);
  await hideCursor(tabId);
  try {
    await chrome.tabs.ungroup(tabId);
  } catch {
    // tab may be gone or never grouped
  }
}

/** Pin a tab to the active control session (idempotent). */
export async function ensurePinned(tabId: number): Promise<boolean> {
  if (!current) return false;
  if (suspendedOwner && suspendedOwner === current.owner) return false;
  if (pinned.has(tabId)) return cdpSessionManager.isAttached(tabId);
  lastActivityAt = Date.now();
  try {
    await cdpSessionManager.attach(tabId, CONTROL_SESSION_OWNER);
    pinned.add(tabId);
    if (!current.tabIds.includes(tabId)) {
      current.tabIds.push(tabId);
      void persist();
    }
    await ensureGrouped(tabId, current.label);
    await ensureMarked(tabId);
    return true;
  } catch (error) {
    console.warn('[control-session] failed to pin tab', tabId, error);
    return false;
  }
}

export async function beginControlSession(
  options: {
    label?: string;
    tabIds?: number[];
    policy?: Partial<ControlSessionPolicy>;
  } = {},
): Promise<ControlSessionState> {
  if (current && current.owner && activeOwner && current.owner !== activeOwner) {
    const idleMs = lastActivityAt ? Date.now() - lastActivityAt : Number.MAX_SAFE_INTEGER;
    if (idleMs < 120000) {
      throw new Error(
        'E_SESSION_BUSY: another agent session (' + current.owner + ') owns the browser control session',
      );
    }
    // Owner vanished (crash / host restart): reclaim after 2 quiet minutes.
    await endControlSession(true);
  }
  if (suspendedOwner === activeOwner) {
    suspendedOwner = '';
    try {
      void chrome.storage.session.remove(SUSPEND_KEY);
    } catch {
      // ignore
    }
  }
  if (!current) {
    current = {
      sessionId: 'dsh-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      owner: activeOwner,
      label: options.label || 'DSH',
      startedAt: Date.now(),
      tabIds: [],
      policy: normalizePolicy(options.policy),
    };
    lastActivityAt = Date.now();
    await persist();
  }
  for (const tabId of options.tabIds || []) await ensurePinned(tabId);
  return current;
}

export async function endControlSession(force = false): Promise<ControlSessionState | null> {
  const previous = current;
  if (!force && previous && previous.owner && activeOwner && previous.owner !== activeOwner) {
    throw new Error('E_SESSION_BUSY: only the owning session may end the control session');
  }
  current = null;
  const tabs = [...pinned];
  pinned.clear();
  groupByWindow.clear();
  for (const tabId of tabs) {
    try {
      await cdpSessionManager.detach(tabId, CONTROL_SESSION_OWNER);
    } catch {
      // best effort
    }
    await unmark(tabId);
  }
  await persist();
  return previous;
}

/** Re-attach pinned tabs after a service-worker restart. */
export async function restoreControlSession(): Promise<void> {
  try {
    const stored = await chrome.storage.session.get([STATE_KEY, SUSPEND_KEY]);
    const suspended = stored?.[SUSPEND_KEY] as string | undefined;
    if (suspended) suspendedOwner = suspended;
    const state = stored?.[STATE_KEY] as ControlSessionState | undefined;
    if (!state) return;
    current = state;
    pinned.clear();
    // A suspension survives the SW restart: never silently re-attach.
    if (suspendedOwner && suspendedOwner === state.owner) return;
    for (const tabId of state.tabIds || []) await ensurePinned(tabId);
  } catch {
    // ignore
  }
}

// Respect an explicit user cancel: end the session and stop auto re-attaching.
try {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (reason !== 'canceled_by_user') return;
    if (!current) return;
    if (typeof source.tabId !== 'number') return;
    suspendedOwner = current.owner;
    try {
      void chrome.storage.session.set({ [SUSPEND_KEY]: suspendedOwner });
    } catch {
      // ignore
    }
    void endControlSession(true).catch(() => {});
    console.warn('[control-session] user canceled debugging; session suspended');
  });
} catch {
  // listener registration is best effort
}

// Lease: if the agent disappears (crash, harness restart, idle), clean up.
const LEASE_IDLE_MS = 10 * 60 * 1000;
try {
  chrome.alarms.create('dsh-session-lease', { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== 'dsh-session-lease') return;
    if (!current) return;
    if (lastActivityAt && Date.now() - lastActivityAt < LEASE_IDLE_MS) return;
    console.warn('[control-session] lease expired; releasing browser resources');
    void endControlSession(true).catch(() => {});
  });
} catch {
  // alarms are best effort
}

// Auto-pin every tab the AI touches while a session is active.
cdpSessionManager.setPinHook((tabId) => {
  void ensurePinned(tabId);
});

try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (!pinned.delete(tabId)) return;
    if (current) {
      current.tabIds = current.tabIds.filter((id) => id !== tabId);
      void persist();
    }
  });
} catch {
  // ignore
}

class ControlSessionTool {
  name = TOOL_NAMES.BROWSER.CONTROL_SESSION;

  async execute(args: any = {}): Promise<ToolResult> {
    const action = String(args?.action || 'status');
    try {
      if (action === 'begin') {
        const state = await beginControlSession({
          label: typeof args?.label === 'string' ? args.label : undefined,
          tabIds: Array.isArray(args?.tabIds)
            ? args.tabIds.filter((n: any) => typeof n === 'number')
            : undefined,
          policy: args?.policy && typeof args.policy === 'object' ? args.policy : undefined,
        });
        return ok({
          ok: true,
          action,
          session: state,
          pinnedTabs: [...pinned],
          attachedTabs: cdpSessionManager.attachedTabIds(),
        });
      }

      if (action === 'end') {
        const previous = await endControlSession();
        return ok({
          ok: true,
          action,
          ended: previous,
          attachedTabs: cdpSessionManager.attachedTabIds(),
        });
      }

      let debuggerTargets: number[] = [];
      try {
        const targets = await chrome.debugger.getTargets();
        debuggerTargets = targets
          .filter((t) => t.attached && typeof t.tabId === 'number')
          .map((t) => t.tabId as number);
      } catch {
        // debugger API unavailable
      }
      if (action === 'policy') {
        const mode = String(args?.confirmMode || '');
        if (!['narrow', 'always', 'off'].includes(mode)) {
          return createErrorResponse('E_BAD_ARG: confirmMode must be narrow | always | off');
        }
        try {
          await chrome.storage.local.set({ 'dsh.policy': { confirmMode: mode } });
        } catch {
          return createErrorResponse('E_STORAGE: could not persist policy');
        }
        return ok({ ok: true, action: 'policy', confirmMode: mode });
      }

      if (action === 'audit') {
        const limit = Math.max(1, Math.min(200, Number(args?.limit) || 50));
        try {
          const got = await chrome.storage.local.get('dsh.audit');
          const list = Array.isArray(got?.['dsh.audit']) ? got['dsh.audit'] : [];
          return ok({ ok: true, action: 'audit', total: list.length, entries: list.slice(-limit) });
        } catch {
          return ok({ ok: true, action: 'audit', total: 0, entries: [] });
        }
      }

      return ok({
        ok: true,
        action: 'status',
        session: current,
        pinnedTabs: [...pinned],
        attachedTabs: cdpSessionManager.attachedTabIds(),
        debuggerTargets,
        suspendedOwner: suspendedOwner || null,
      });
    } catch (error) {
      return createErrorResponse(
        'control_session failed: ' + (error instanceof Error ? error.message : String(error)),
      );
    }
  }
}

export const controlSessionTool = new ControlSessionTool();
