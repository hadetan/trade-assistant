// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeToggle, useChatTheme } from "../../src/renderer/ThemeToggle";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe("useChatTheme", () => {
  it("defaults to dark when localStorage has no saved theme", () => {
    const { result } = renderHook(() => useChatTheme());
    expect(result.current[0]).toBe("dark");
  });

  it("defaults to dark when the saved value is neither dark nor light", () => {
    localStorage.setItem("chatTheme", "purple");
    const { result } = renderHook(() => useChatTheme());
    expect(result.current[0]).toBe("dark");
  });

  it("reads a previously persisted theme on mount", () => {
    localStorage.setItem("chatTheme", "light");
    const { result } = renderHook(() => useChatTheme());
    expect(result.current[0]).toBe("light");
  });

  it("toggling flips the theme and persists it to localStorage", () => {
    const { result } = renderHook(() => useChatTheme());
    act(() => result.current[1]());
    expect(result.current[0]).toBe("light");
    expect(localStorage.getItem("chatTheme")).toBe("light");
  });

  it("rehydrates the persisted value on a fresh mount", () => {
    const first = renderHook(() => useChatTheme());
    act(() => first.result.current[1]());
    first.unmount();

    const second = renderHook(() => useChatTheme());
    expect(second.result.current[0]).toBe("light");
  });
});

describe("ThemeToggle", () => {
  it("shows a sun icon and offers to switch to light when the theme is dark", () => {
    render(<ThemeToggle theme="dark" onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /switch to light theme/i })).toBeTruthy();
  });

  it("shows a moon icon and offers to switch to dark when the theme is light", () => {
    render(<ThemeToggle theme="light" onToggle={() => {}} />);
    expect(screen.getByRole("button", { name: /switch to dark theme/i })).toBeTruthy();
  });

  it("calls onToggle when clicked", () => {
    let calls = 0;
    render(<ThemeToggle theme="light" onToggle={() => calls++} />);
    fireEvent.click(screen.getByRole("button"));
    expect(calls).toBe(1);
  });
});
