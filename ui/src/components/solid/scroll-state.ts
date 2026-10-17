import { createEffect, createMemo, useContext } from "solid-js";
import { ContentPresentation } from "../../lib/solid/presentation.ts";
import { observeScrollState } from "../scroll-state-observer.ts";

export function useScrollState() {
  const presented = useContext(ContentPresentation);
  let element: HTMLElement;
  createEffect(createMemo(presented), (active) => {
    if (!active) {
      return undefined;
    }
    const observation = observeScrollState(element, (state) => {
      for (const key of ["scrollable", "atStart", "atEnd"] as const) {
        const value = String(state[key]);
        if (element.dataset[key] !== value) {
          element.dataset[key] = value;
        }
      }
    });
    return () => observation.disconnect();
  });
  return (value: HTMLElement) => {
    element = value;
  };
}
