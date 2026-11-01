import { revealWorkspaceTab } from "@/workspace-tabs/navigation";
import { useCallback, useMemo } from "react";
import { createWorkspaceFileAttachment } from "@/attachments/workspace-file";
import { resolveFocusedChatTarget } from "@/composer/focused-chat-target";
import { useDraftStore } from "@/stores/draft-store";
import { useEffectiveWorkspaceLayout } from "@/stores/workspace-layout-store";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";

export function useAddFileToChat(input: { serverId: string; workspaceId?: string | null }) {
  const workspaceKey = input.workspaceId
    ? buildWorkspaceTabPersistenceKey({ serverId: input.serverId, workspaceId: input.workspaceId })
    : null;
  // The effective layout, not the persisted one: during an attention reveal the
  // chat on screen is the revealed agent's, and "add to chat" must target it.
  const layout = useEffectiveWorkspaceLayout(workspaceKey);
  const focusedChat = useMemo(
    () => resolveFocusedChatTarget({ serverId: input.serverId, layout: layout ?? undefined }),
    [input.serverId, layout],
  );
  const addFile = useCallback(
    async (filePath: string) => {
      if (!focusedChat || !workspaceKey) {
        return;
      }
      await useDraftStore.getState().attachWorkspaceFile({
        draftKey: focusedChat.draftKey,
        attachment: createWorkspaceFileAttachment({ path: filePath }),
      });
      revealWorkspaceTab(workspaceKey, focusedChat.tabId);
    },
    [focusedChat, workspaceKey],
  );
  return { addFile, canAddToChat: focusedChat !== null };
}
