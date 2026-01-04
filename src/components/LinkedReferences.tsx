import { createMemo, For, Show } from 'solid-js';
import { useWorkspace } from '../context/WorkspaceContext';
import { parseAllInlineTokens } from '../lib/inlineParser';

interface LinkedReferencesProps {
  zoomedRootId: string;
}

const normalizeTitle = (value: string): string => {
  return value.trim().replace(/^#+\s+/, '').toLowerCase();
};

export function LinkedReferences(props: LinkedReferencesProps) {
  const { blockStore } = useWorkspace();

  const pageTitle = createMemo(() => {
    const root = blockStore.blocks[props.zoomedRootId];
    if (!root) return '';
    return root.content.trim().replace(/^#+\s+/, '');
  });

  const references = createMemo(() => {
    const title = pageTitle();
    if (!title) return [];
    const normalizedTitle = normalizeTitle(title);

    return Object.values(blockStore.blocks)
      .filter((block) => {
        if (block.id === props.zoomedRootId) return false;
        const tokens = parseAllInlineTokens(block.content);
        return tokens.some((token) => {
          if (token.type !== 'link' || !token.linkTarget) return false;
          return normalizeTitle(token.linkTarget) === normalizedTitle;
        });
      });
  });

  return (
    <Show when={references().length > 0}>
      <div class="linked-references">
        <div class="linked-references-title">Linked References</div>
        <ul class="linked-references-list">
          <For each={references()}>
            {(block) => (
              <li class="linked-references-item">{block.content}</li>
            )}
          </For>
        </ul>
      </div>
    </Show>
  );
}
