import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';

const TOOL_MESSAGE_TIMEOUT_MS = 6000;

/** Content scripts can be missing/stale (e.g. right after an extension reload) and
 * then `chrome.tabs.sendMessage` never settles. Never let a tool hang on that. */
function withToolTimeout<T>(promise: Promise<T>, ms = TOOL_MESSAGE_TIMEOUT_MS): Promise<T | null> {
  return Promise.race([
    promise.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function cdpClickAt(tabId: number, selector: string): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      },
      args: [selector],
    });
    const point = results?.[0]?.result as any;
    if (!point) return false;
    await cdpSessionManager.attach(tabId, 'click-fallback');
    try {
      await cdpSessionManager
        .sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true })
        .catch(() => {});
      const base = {
        x: Math.round(point.x),
        y: Math.round(point.y),
        button: 'left',
        clickCount: 1,
        buttons: 1,
      };
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        ...base,
        type: 'mouseMoved',
        buttons: 0,
      });
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        ...base,
        type: 'mousePressed',
      });
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        ...base,
        type: 'mouseReleased',
      });
    } finally {
      await cdpSessionManager.detach(tabId, 'click-fallback').catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

async function cdpFillAt(tabId: number, selector: string, value: string): Promise<boolean> {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
        return true;
      },
      args: [selector],
    });
    if (!results?.[0]?.result) return false;
    await cdpSessionManager.attach(tabId, 'fill-fallback');
    try {
      await cdpSessionManager
        .sendCommand(tabId, 'Emulation.setFocusEmulationEnabled', { enabled: true })
        .catch(() => {});
      // Ctrl+A then insert (replaces existing content)
      const key = { key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 };
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        ...key,
      });
      await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        ...key,
      });
      await cdpSessionManager.sendCommand(tabId, 'Input.insertText', { text: String(value) });
    } finally {
      await cdpSessionManager.detach(tabId, 'fill-fallback').catch(() => {});
    }
    return true;
  } catch {
    return false;
  }
}

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__claudeElementMap)
  coordinates?: Coordinates; // Coordinates to click at (x, y relative to viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const {
      selector,
      selectorType = 'css',
      coordinates,
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    if (!selector && !coordinates && !args.ref) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector or coordinates',
      );
    }

    try {
      // Resolve tab
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = args.ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Bounded: heavy pages can stall frame injection for tens of seconds.
      await withToolTimeout(
        this.injectContentScript(tab.id, ['inject-scripts/click-helper.js']),
        6000,
      );

      // Send click message to content script (bounded: a background tab may never answer)
      const result = await withToolTimeout(
        this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
          selector: finalSelector,
          coordinates,
          ref: finalRef,
          waitForNavigation,
          timeout,
          double: args.double === true,
          button,
          bubbles,
          cancelable,
          modifiers,
        },
          frameId,
        ),
      );

      if (!result) {
        return createErrorResponse(
          'E_UNCERTAIN: the page never answered the click (background tab may be throttled). ' +
            'No retry was attempted to avoid a double action. Verify the page state before retrying.',
        );
      }

      if (result.backgroundOpen) {
        // The target is a link that would open (and activate) a new tab. Open it
        // ourselves in the background so the user's foreground never changes.
        try {
          const created = await chrome.tabs.create({
            url: String(result.backgroundOpen),
            active: false,
            windowId: tab.windowId,
            openerTabId: tab.id,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Link opened in a background tab (foreground untouched)',
                  tabId: created.id,
                  url: result.backgroundOpen,
                  elementInfo: result.elementInfo,
                  openedInBackground: true,
                }),
              },
            ],
            isError: false,
          };
        } catch (openError) {
          // fall through to a normal click if the background open failed
        }
      }

      if (result.error && /not found/i.test(String(result.error))) {
        // Definitive "element missing" means nothing was clicked yet: CDP is safe.
        if (finalSelector && (await cdpClickAt(tab.id, finalSelector))) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Element clicked via CDP fallback (DOM helper could not resolve it)',
                  selector: finalSelector,
                  method: 'cdp-fallback',
                }),
              },
            ],
            isError: false,
          };
        }
      }

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Click operation successful',
              elementInfo: result.elementInfo,
              navigationOccurred: result.navigationOccurred,
              clickMethod,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponse(
        `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  // Accept string | number | boolean for broader form input coverage
  value: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const { selector, selectorType = 'css', ref, value, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    if (!selector && !ref) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Provide ref or selector');
    }

    if (value === undefined || value === null) {
      return createErrorResponse(ERROR_MESSAGES.INVALID_PARAMETERS + ': Value must be provided');
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      let finalRef = ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Frame injection can stall on heavy SPA pages (never call it unbounded).
      const injected = await withToolTimeout(
        this.injectContentScript(tab.id, ['inject-scripts/fill-helper.js']),
        6000,
      );

      // Send fill message to content script, but never hang: background tabs can
      // throttle the injected helper so the reply never arrives.
      const result = injected
        ? await withToolTimeout(
            this.sendMessageToTab(
              tab.id,
              {
                action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
                selector: finalSelector,
                ref: finalRef,
                value,
              },
              frameId,
            ),
          )
        : null;

      if (!result) {
        // The content-script path never answered. Filling through CDP is safe
        // here because nothing was typed yet (the helper was never reached).
        if (finalSelector) {
          const ok = await withToolTimeout(cdpFillAt(tab.id, finalSelector, String(value)), 9000);
          if (ok) {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Element filled successfully (CDP input)',
                    path: 'cdp',
                    selector: finalSelector,
                  }),
                },
              ],
              isError: false,
            };
          }
        }
        return createErrorResponse(
          'E_UNCERTAIN: the page never answered the fill request (background tab may be throttled). ' +
            'No retry was attempted to avoid duplicating text. Verify the field value before retrying.',
        );
      }

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      return createErrorResponse(
        `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillTool = new FillTool();
