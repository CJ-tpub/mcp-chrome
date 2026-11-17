import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { cdpSessionManager } from '@/utils/cdp-session-manager';

/** Trusted (isTrusted=true) key dispatch via CDP. Synthetic DOM events are ignored
 * by many SPAs (e.g. site search boxes), so prefer real input when we can. */
const CDP_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };

function resolveKeyToken(token: string): { key: string; code: string; vk: number; text?: string } | null {
  const trimmed = token.trim();
  if (CDP_KEYS[trimmed]) return CDP_KEYS[trimmed];
  if (trimmed.length === 1) {
    const ch = trimmed;
    const upper = ch.toUpperCase();
    const isLetter = /[a-z]/i.test(ch);
    const isDigit = /[0-9]/.test(ch);
    const vk = isLetter ? upper.charCodeAt(0) : isDigit ? ch.charCodeAt(0) : ch.charCodeAt(0);
    return { key: ch, code: isLetter ? 'Key' + upper : isDigit ? 'Digit' + ch : '', vk, text: ch };
  }
  return null;
}

interface KeyboardToolParams {
  keys: string; // Required: string representing keys or key combinations to simulate (e.g., "Enter", "Ctrl+C")
  selector?: string; // Optional: CSS selector or XPath for target element to send keyboard events to
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  delay?: number; // Optional: delay between keystrokes in milliseconds
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  frameId?: number; // target frame id for iframe support
}

/**
 * Tool for simulating keyboard input on web pages
 */
class KeyboardTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.KEYBOARD;

  /**
   * Execute keyboard operation
   */
  async execute(args: KeyboardToolParams & { text?: string }): Promise<ToolResult> {
    // Accept both `keys` and the more common `text` spelling from tool callers.
    const { selector, selectorType = 'css', delay = TIMEOUTS.KEYBOARD_DELAY } = args;
    const keys = (args as any).keys ?? (args as any).text;

    console.log(`Starting keyboard operation with options:`, args);

    if (!keys) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Keys parameter must be provided',
      );
    }

    try {
      const explicit = await this.tryGetTab(args.tabId);
      const tab = explicit || (await this.getActiveTabOrThrowInWindow(args.windowId));
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }

      // Preferred path: real CDP key events (trusted).
      try {
        const rawChords = String(keys).split(',').map((s) => s.trim()).filter(Boolean);
        const chords = rawChords.flatMap((chord) => {
          const plain = chord.split('+').map((s) => s.trim()).filter(Boolean);
          // "abc" (no modifiers) means three literal characters, not one key.
          if (plain.length === 1 && plain[0].length > 1 && !CDP_KEYS[plain[0]]) {
            return plain[0].split('');
          }
          return [chord];
        });
        const parsed = chords.map((chord) => {
          const parts = chord.split('+').map((s) => s.trim()).filter(Boolean);
          if (!parts.length) return null;
          const keyToken = parts.pop() as string;
          const mods = parts.reduce((mask, m) => mask | (MODIFIER_BITS[m] || 0), 0);
          const key = resolveKeyToken(keyToken);
          return key ? { ...key, mods } : null;
        });
        if (parsed.length && parsed.every(Boolean)) {
          // Focus the requested element first: CDP key events go to whatever is
          // focused, and a previous fill/click may have moved focus elsewhere.
          if (selector) {
            await chrome.scripting
              .executeScript({
                target: { tabId: tab.id },
                func: (sel: string) => {
                  const el = document.querySelector(sel) as HTMLElement | null;
                  if (!el) return false;
                  el.focus();
                  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
                  return document.activeElement === el;
                },
                args: [String(selector)],
              })
              .catch(() => undefined);
          }
          await cdpSessionManager.attach(tab.id, 'keyboard');
          try {
            for (const item of parsed as any[]) {
              await cdpSessionManager.sendCommand(tab.id, 'Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: item.key,
                code: item.code,
                windowsVirtualKeyCode: item.vk,
                nativeVirtualKeyCode: item.vk,
                modifiers: item.mods,
                text: item.mods ? undefined : item.text,
              });
              await cdpSessionManager.sendCommand(tab.id, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: item.key,
                code: item.code,
                windowsVirtualKeyCode: item.vk,
                nativeVirtualKeyCode: item.vk,
                modifiers: item.mods,
              });
              if (delay) await new Promise((r) => setTimeout(r, delay));
            }
          } finally {
            await cdpSessionManager.detach(tab.id, 'keyboard').catch(() => {});
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Keyboard events dispatched (CDP, trusted)',
                  keys: String(keys),
                  path: 'cdp',
                }),
              },
            ],
            isError: false,
          };
        }
      } catch (cdpError) {
        console.warn('[keyboard] CDP path failed, falling back to DOM:', cdpError);
      }

      let finalSelector = selector;
      let refForFocus: string | undefined = undefined;

      // Frame injection can stall on heavy pages; never let it consume the call.
      await Promise.race([
        this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']).catch(
          () => undefined,
        ),
        new Promise((resolve) => setTimeout(resolve, 6000)),
      ]);

      // If selector is XPath, convert to ref then try to get CSS selector
      if (selector && selectorType === 'xpath') {
        try {
          // First convert XPath to ref
          const ensured = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector,
            isXPath: true,
          });
          if (!ensured || !ensured.success || !ensured.ref) {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${ensured?.error || 'unknown error'}`,
            );
          }
          refForFocus = ensured.ref;
          // Try to resolve ref to CSS selector
          const resolved = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
            ref: ensured.ref,
          });
          if (resolved && resolved.success && resolved.selector) {
            finalSelector = resolved.selector;
            refForFocus = undefined; // Prefer CSS selector if available
          }
          // If no CSS selector available, we'll use ref to focus below
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // If we have a ref but no CSS selector, focus the element via helper
      if (refForFocus) {
        const focusResult = await this.sendMessageToTab(tab.id, {
          action: 'focusByRef',
          ref: refForFocus,
        });
        if (focusResult && !focusResult.success) {
          return createErrorResponse(
            `Failed to focus element by ref: ${focusResult.error || 'unknown error'}`,
          );
        }
        // Clear selector so keyboard events go to the focused element
        finalSelector = undefined;
      }

      const frameIds = typeof args.frameId === 'number' ? [args.frameId] : undefined;
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/keyboard-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIds,
      );

      // Send keyboard simulation message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD,
          keys,
          selector: finalSelector,
          delay,
        },
        args.frameId,
      );

      if (result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Keyboard operation successful',
              targetElement: result.targetElement,
              results: result.results,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in keyboard operation:', error);
      return createErrorResponse(
        `Error simulating keyboard events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const keyboardTool = new KeyboardTool();
