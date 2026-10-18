import { createMemo, onCleanup, Show } from "solid-js";
import { SessionProgressCard } from "../../../components/session-progress-card-solid.tsx";
import { PRESENTATION_CHANGED_EVENT } from "../../../lib/presentation.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { projectSource } from "../../../lib/reactive/projection.ts";
import { renderChatQueueSolid as ChatQueue } from "./chat-composer-queue.tsx";
import { isChatRunWorking } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function ComposerQueue(view: { composer: ChatComposerProps; showAbortableUi: boolean }) {
  const canAct = () =>
    view.composer.connected && view.composer.canSend && !view.composer.submitDisabledReason;
  return (
    <ChatQueue
      queue={view.composer.queue}
      displayQueue={view.composer.displayQueue}
      connected={view.composer.connected}
      offline={view.composer.offline}
      canAbort={view.showAbortableUi}
      canRemoveServerQueued={canAct()}
      onQueueRetry={canAct() ? view.composer.onQueueRetry : undefined}
      onQueueSteer={canAct() ? view.composer.onQueueSteer : undefined}
      onQueueMove={view.composer.onQueueMove}
      queuedEdit={view.composer.queuedEdit}
      onQueueRemove={view.composer.onQueueRemove}
    />
  );
}

export function ComposerInputScope(props: {
  state: ChatComposerState;
  children: import("@solidjs/web").JSX.Element;
}) {
  onCleanup(() => props.state.composerInputRef?.());
  return <>{props.children}</>;
}

export function ComposerProgress(view: { composer: ChatComposerProps; shown: boolean }) {
  const visibility = createMemo(() =>
    projectSource(view.composer.progressCardVisibility, {
      read: (binding) => binding?.isPresented() ?? true,
      subscribe: (binding, notify) =>
        binding ? listen(binding.owner, PRESENTATION_CHANGED_EVENT, notify) : () => {},
      equality: Object.is,
    }),
  );
  const presented = () => visibility().read();
  return (
    <Show
      when={presented() && Boolean(view.composer.progressCard)}
      fallback={
        presented() && view.composer.progressCardInitialLoading ? (
          <div
            class="agent-chat__progress-float agent-chat__progress-float--loading"
            hidden={!view.shown}
            aria-hidden="true"
          />
        ) : undefined
      }
    >
      <div class="agent-chat__progress-float" hidden={!view.shown}>
        <SessionProgressCard
          card={view.composer.progressCard}
          placement="composer"
          onDismiss={view.composer.onDismissProgressCard}
          sessionStatus={view.composer.selectedSession?.status}
          startedAt={view.composer.selectedSession?.startedAt}
          endedAt={view.composer.selectedSession?.endedAt}
          hasActiveRun={isChatRunWorking(view.composer)}
          collapseComposerByDefault={view.composer.collapseTaskProgress}
          composerDisclosureContext={{
            presented: view.shown,
            gatewayScope: view.composer.gatewayScope,
            sessionIdentity: view.composer.progressCardIdentity,
            cardLifetime: view.composer.progressCardLifetime,
            readingHistory: view.composer.readingHistory,
            onManipulate: view.composer.onProgressManipulate,
          }}
          refreshAction={
            view.composer.connected && view.composer.canSend
              ? view.composer.progressCardRefresh
              : undefined
          }
          onClearSaved={view.composer.onClearSavedProgressCard}
        />
      </div>
    </Show>
  );
}
