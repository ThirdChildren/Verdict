// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskIdCopy } from "./TaskIdCopy.js";

afterEach(cleanup);
const id = "task_0123456789abcdef";

describe("TaskIdCopy", () => {
  it("shows the full id and copies it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<TaskIdCopy taskId={id} />);
    expect(screen.getByText(id)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy task id" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(id);
  });

  it("falls back to execCommand when the clipboard API fails", async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("no")) },
    });
    const exec = vi.fn().mockReturnValue(true);
    Object.assign(document, { execCommand: exec });
    render(<TaskIdCopy taskId={id} />);
    fireEvent.click(screen.getByRole("button", { name: "Copy task id" }));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(exec).toHaveBeenCalledWith("copy");
  });
});
