/**
 * Tracks the in-flight run for each key (e.g. `<folder>|eslint`) so the same
 * tool never runs twice at once. Starting a new run cancels the previous one,
 * and the superseded run can tell (via `isCurrent`) that it must not publish
 * its now-stale results. Pure and vscode-free so it is unit-tested.
 */
export interface RunHandle {
  readonly id: number;
  /** False once a newer run for the same key has started. */
  isCurrent(): boolean;
  /** Mark this run finished. No-op if it was superseded. */
  end(): void;
}

export class RunRegistry {
  private readonly current = new Map<string, { id: number; cancel: () => void }>();
  private nextId = 1;

  /** Start a run for `key`, cancelling any run already in flight for it. */
  begin(key: string, cancel: () => void): RunHandle {
    const previous = this.current.get(key);
    const id = this.nextId++;
    this.current.set(key, { id, cancel });
    previous?.cancel();
    return {
      id,
      isCurrent: () => this.current.get(key)?.id === id,
      end: () => {
        if (this.current.get(key)?.id === id) {
          this.current.delete(key);
        }
      },
    };
  }

  isRunning(key: string): boolean {
    return this.current.has(key);
  }

  /** Cancel and forget every in-flight run (extension deactivation). */
  cancelAll(): void {
    const runs = [...this.current.values()];
    this.current.clear();
    for (const run of runs) {
      run.cancel();
    }
  }
}
