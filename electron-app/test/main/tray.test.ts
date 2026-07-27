import { describe, expect, it, vi } from "vitest";
import { buildTrayMenuTemplate } from "../../src/main/tray";

describe("buildTrayMenuTemplate", () => {
  it("returns Show, Settings, a separator, then Quit in that order", () => {
    const template = buildTrayMenuTemplate({ showMainWindow: vi.fn(), showSettingsWindow: vi.fn(), quit: vi.fn() });
    expect(template.map((item) => item.label ?? item.type)).toEqual(["Show", "Settings", "separator", "Quit"]);
  });

  it("wires each item's click to the corresponding dependency exactly once", () => {
    const showMainWindow = vi.fn();
    const showSettingsWindow = vi.fn();
    const quit = vi.fn();
    const template = buildTrayMenuTemplate({ showMainWindow, showSettingsWindow, quit });

    (template[0].click as () => void)();
    (template[1].click as () => void)();
    (template[3].click as () => void)();

    expect(showMainWindow).toHaveBeenCalledTimes(1);
    expect(showSettingsWindow).toHaveBeenCalledTimes(1);
    expect(quit).toHaveBeenCalledTimes(1);
  });
});
