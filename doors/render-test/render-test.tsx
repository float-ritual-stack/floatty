/**
 * render-test — Verify json-render + compile-door-bundle pipeline.
 * Pattern from spike's working render door + session-garden catalog.
 */
import {
  Renderer,
  defineRegistry,
  StateProvider,
  ActionProvider,
  VisibilityProvider,
  ValidationProvider,
} from '@json-render/solid';
import { schema } from '@json-render/solid/schema';
import { z } from 'zod';

const catalog = schema.createCatalog({
  components: {
    Text: {
      props: z.object({ content: z.string() }),
      slots: [],
      description: 'Simple text',
    },
  },
});

const { registry } = defineRegistry(catalog, {
  components: {
    Text: (props: any) => <p style={{ color: '#8ec07c' }}>{props.props.content}</p>,
  },
});

function RenderTestView(props: { data: unknown }) {
  const spec = {
    root: 'greeting',
    elements: {
      greeting: { type: 'Text', props: { content: 'json-render pipeline works!' } },
    },
  };

  return (
    <div style={{ padding: '8px', background: '#1d2021', 'border-radius': '4px' }}>
      <StateProvider initialState={{}}>
        <ActionProvider handlers={{}}>
          <VisibilityProvider>
            <ValidationProvider>
              <Renderer spec={spec} registry={registry} />
            </ValidationProvider>
          </VisibilityProvider>
        </ActionProvider>
      </StateProvider>
    </div>
  );
}

export const meta = {
  id: 'render-test',
  name: 'Render Test',
  version: '0.0.1',
  selfRender: true,
};

export const door = {
  kind: 'view' as const,
  prefixes: ['render-test::'],
  async execute(blockId: string, content: string, ctx: any) {
    ctx.actions.setBlockOutput(blockId, { kind: 'view', doorId: 'render-test', schema: 1, data: {} }, 'door');
    ctx.actions.setBlockStatus(blockId, 'complete');
  },
  view: RenderTestView,
};
