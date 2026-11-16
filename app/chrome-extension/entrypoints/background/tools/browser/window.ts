import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';

class WindowTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.GET_WINDOWS_AND_TABS;
  async execute(): Promise<ToolResult> {
    try {
      const windows = await chrome.windows.getAll({ populate: true });
      let tabCount = 0;

      // Resolve tab-group titles once per window so callers can verify the
      // "controlled tabs are grouped" affordance without extra APIs.
      const groupTitles = new Map<number, string>();
      for (const window of windows) {
        const ids = new Set<number>();
        for (const tab of window.tabs || []) {
          if (typeof (tab as any).groupId === 'number' && (tab as any).groupId >= 0) {
            ids.add((tab as any).groupId);
          }
        }
        for (const id of ids) {
          try {
            const group = await chrome.tabGroups.get(id);
            groupTitles.set(id, group.title || '');
          } catch {
            // ignore vanished groups
          }
        }
      }

      const structuredWindows = windows.map((window) => {
        const tabs =
          window.tabs?.map((tab) => {
            tabCount++;
            const groupId = typeof (tab as any).groupId === 'number' ? (tab as any).groupId : -1;
            return {
              tabId: tab.id || 0,
              url: tab.url || '',
              title: tab.title || '',
              active: tab.active || false,
              groupId,
              groupTitle: groupId >= 0 ? groupTitles.get(groupId) || '' : '',
            };
          }) || [];

        return {
          windowId: window.id || 0,
          tabs: tabs,
        };
      });

      const result = {
        windowCount: windows.length,
        tabCount: tabCount,
        windows: structuredWindows,
      };

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in WindowTool.execute:', error);
      return createErrorResponse(
        `Error getting windows and tabs information: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const windowTool = new WindowTool();
