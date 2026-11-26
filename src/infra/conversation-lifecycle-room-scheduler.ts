import type { LifecycleObligation } from "./conversation-lifecycle.reducer.js";

type RoomBatch = {
  rows: LifecycleObligation[];
  done: PromiseWithResolvers<void>;
};

const MAX_ACTIVE_ROOMS = 4;

/** Bounded publication across rooms with at most one owner per room. */
export function createLifecycleRoomScheduler(options: {
  isClosing: () => boolean;
  publish: (roomId: string, rows: LifecycleObligation[]) => Promise<void>;
  onSettled: (roomId: string) => void;
  onError: (error: unknown) => void;
}) {
  const pendingRooms = new Map<string, RoomBatch>();
  const activeRooms = new Map<string, RoomBatch>();

  const startRooms = (): void => {
    if (options.isClosing() || activeRooms.size >= MAX_ACTIVE_ROOMS) {
      return;
    }
    for (const [roomId, batch] of pendingRooms) {
      if (activeRooms.has(roomId)) {
        continue;
      }
      pendingRooms.delete(roomId);
      activeRooms.set(roomId, batch);
      const complete = (failure?: { error: unknown }) => {
        activeRooms.delete(roomId);
        options.onSettled(roomId);
        if (failure) {
          batch.done.reject(failure.error);
        } else {
          batch.done.resolve();
        }
        startRooms();
      };
      void options.publish(roomId, batch.rows).then(
        () => complete(),
        (error) => complete({ error }),
      );
      if (activeRooms.size >= MAX_ACTIVE_ROOMS) {
        break;
      }
    }
  };

  return {
    activeRooms: activeRooms as ReadonlyMap<string, RoomBatch>,
    schedule(byRoom: ReadonlyMap<string, LifecycleObligation[]>): Promise<void>[] {
      const scheduled: Promise<void>[] = [];
      for (const [roomId, rows] of byRoom) {
        const active = activeRooms.get(roomId);
        if (active) {
          scheduled.push(active.done.promise);
        }
        const queued = pendingRooms.get(roomId);
        if (queued) {
          queued.rows = rows;
          scheduled.push(queued.done.promise);
          continue;
        }
        if (active) {
          const revisions = new Map(active.rows.map((row) => [row.id, row.revision]));
          if (rows.every((row) => (revisions.get(row.id) ?? -1) >= row.revision)) {
            continue;
          }
        }
        const batch = { rows, done: Promise.withResolvers<void>() };
        void batch.done.promise.catch(options.onError);
        pendingRooms.set(roomId, batch);
        scheduled.push(batch.done.promise);
      }
      // A newer snapshot can retire work that never started.
      for (const [roomId, batch] of pendingRooms) {
        if (!byRoom.has(roomId)) {
          pendingRooms.delete(roomId);
          batch.done.resolve();
        }
      }
      startRooms();
      return scheduled;
    },
    cancelPending(): void {
      for (const batch of pendingRooms.values()) {
        batch.done.resolve();
      }
      pendingRooms.clear();
    },
  };
}
