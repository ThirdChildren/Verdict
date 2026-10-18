// Visual feedback loop: screenshots of every mock storyboard scene (+ extra views) into .logs/shots.
// Usage: pnpm ui:shots [scene-id ...]   (no args = everything). Add new views to EXTRAS.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "@playwright/test";

const PORT = 5199;
const BASE = `http://localhost:${PORT}/?mock=1`;
const OUT = ".logs/shots";
// QUICK=1 pnpm ui:shots <ids>: 1280x720 and 1280x640 light (fast feedback loop).
const QUICK = process.env.QUICK === "1";
const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1280x640", width: 1280, height: 640 },
].filter((v) => !QUICK || v.name !== "1440x900");
const THEMES = (QUICK ? ["light"] : ["light", "dark"]) as readonly ("light" | "dark")[];

interface Extra {
  id: string;
  scene: string;
  /** Prepare the page after the scene is selected. */
  act: (page: Page) => Promise<void>;
}
const EXAMPLE = "Pay up to 5 tUSD to worker to convert CSV files to JSON, within 12 hours";
/** Opens the mandate wizard and advances it: stage 1 = review, 2 = signed. */
async function wizard(p: Page, text: string, stage: 1 | 2): Promise<void> {
  await p.getByRole("button", { name: /create mandate/i }).click();
  await p.getByRole("textbox").fill(text);
  await p.getByRole("button", { name: /draft mandate/i }).click();
  await p.getByRole("button", { name: /approve and sign/i }).waitFor();
  if (stage === 1) return;
  await p.getByRole("button", { name: /approve and sign/i }).click();
  await p.getByText(/signed by your principal key/i).waitFor();
}
// Extend here (e.g. the demo console) with another { id, scene, act }.
const EXTRAS: Extra[] = [
  {
    id: "refused",
    scene: "refused",
    act: async (p) => {
      await p.getByRole("button", { name: /^new task$/i }).click();
      await p.getByLabel(/what should the worker do/i).fill("develop a snake game");
      await p.getByRole("button", { name: /start task/i }).click();
      await p
        .getByRole("alert")
        .filter({ hasText: /only buys work it can verify/i })
        .waitFor();
    },
  },
  { id: "mandate-dialog", scene: "authorized", act: (p) => p.keyboard.press("m") },
  {
    id: "mandate-wizard",
    scene: "empty",
    act: (p) => p.getByRole("button", { name: /create mandate/i }).click(),
  },
  { id: "inspector", scene: "settled", act: (p) => p.keyboard.press("i") },
  {
    id: "inspector-events",
    scene: "settled",
    act: async (p) => {
      await p.keyboard.press("i");
      await p.getByRole("tab", { name: /events/i }).click();
      await p.locator("summary").first().click();
    },
  },
  { id: "stats", scene: "settled", act: (p) => p.keyboard.press("s") },
  { id: "agents", scene: "settled", act: (p) => p.keyboard.press("a") },
  { id: "agents-blocked", scene: "blocked", act: (p) => p.keyboard.press("a") },
  { id: "shortcut-help", scene: "working", act: (p) => p.keyboard.press("?") },
  { id: "presenter", scene: "working", act: (p) => p.keyboard.press("p") },
  { id: "wizard-review", scene: "empty", act: (p) => wizard(p, EXAMPLE, 1) },
  { id: "wizard-review-flagged", scene: "empty", act: (p) => wizard(p, "Convert my csv", 1) },
  { id: "console", scene: "working", act: (p) => p.keyboard.press("d") },
  {
    id: "console-mining",
    scene: "ring",
    act: async (p) => {
      await p.keyboard.press("d");
      await p.getByRole("button", { name: /^mine until refund$/i }).click();
      await p.waitForTimeout(900);
    },
  },
  {
    id: "ring-mining",
    scene: "ring",
    act: async (p) => {
      await p.keyboard.press("d");
      await p.getByRole("button", { name: /^mine until refund$/i }).click();
      await p.waitForTimeout(900);
      await p.keyboard.press("d");
    },
  },
  {
    id: "second-mandate-wizard",
    scene: "second-mandate",
    act: async (p) => {
      await p.getByRole("button", { name: /new mandate/i }).click();
      await p.getByRole("textbox").fill(EXAMPLE);
      await p.getByRole("button", { name: /draft mandate/i }).click();
      await p.getByRole("button", { name: /approve and sign/i }).waitFor();
    },
  },
  {
    id: "second-mandate-done",
    scene: "second-mandate",
    act: async (p) => {
      await p.getByRole("button", { name: /new mandate/i }).click();
      await p.getByRole("textbox").fill(EXAMPLE);
      await p.getByRole("button", { name: /draft mandate/i }).click();
      await p.getByRole("button", { name: /approve and sign/i }).click();
      await p.getByText(/signed by your principal key/i).waitFor();
      await p.getByRole("button", { name: /start working/i }).click();
    },
  },
  // Principal and funds (U1): disconnected header, connected header + funds panel, mandate review with the ceiling field.
  { id: "principal-disconnected", scene: "authorized", act: async () => {} },
  {
    id: "principal-connected",
    scene: "authorized",
    act: async (p) => {
      await p.getByRole("button", { name: "Connect principal" }).click();
      await p.getByText("Available to delegate").waitFor();
    },
  },
  {
    id: "mandate-dialog-funds",
    scene: "empty",
    act: async (p) => {
      await p.getByRole("button", { name: "Connect principal" }).click();
      await p.getByText("Available to delegate").waitFor();
      await wizard(p, EXAMPLE, 1);
      await p.getByText(/^Available to delegate:/).waitFor();
    },
  },
  {
    id: "mandate-dialog-over",
    scene: "empty",
    act: async (p) => {
      await p.getByRole("button", { name: "Connect principal" }).click();
      await p.getByText("Available to delegate").waitFor();
      await wizard(p, EXAMPLE, 1);
      await p.getByRole("textbox", { name: /spending ceiling/i }).fill("80");
    },
  },
  {
    id: "more-menu",
    scene: "authorized",
    act: async (p) => {
      await p.getByRole("button", { name: "More" }).click();
    },
  },
  {
    id: "author",
    scene: "author",
    act: async (p) => {
      await p.getByRole("button", { name: /^new task$/i }).click();
      await p.getByLabel(/what should the worker do/i).fill("sum two numbers");
      await p.getByRole("button", { name: /write a test/i }).click();
      await p.getByRole("region", { name: /acceptance test/i }).waitFor();
    },
  },
  { id: "wizard-signed", scene: "empty", act: (p) => wizard(p, EXAMPLE, 2) },
  // Mandate history: select the retired mandate (frozen figures, read-only NEW TASK).
  {
    id: "mandates-history",
    scene: "mandates-history",
    act: async (p) => {
      await p.getByRole("navigation", { name: "Mandates" }).getByRole("button").nth(1).click();
    },
  },
];

async function waitForServer(vite: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (vite.exitCode !== null) throw new Error("vite exited early");
    try {
      if ((await fetch(BASE)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("vite did not start");
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => a !== "--");
  mkdirSync(OUT, { recursive: true });
  const vite = spawn(
    "pnpm",
    ["--filter", "@verdict/demo-ui", "exec", "vite", "--port", String(PORT), "--strictPort"],
    {
      stdio: "ignore",
    },
  );
  try {
    await waitForServer(vite);
    const browser = await chromium.launch();
    for (const theme of THEMES) {
      for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: vp, reducedMotion: "reduce" });
        await ctx.addInitScript((t) => localStorage.setItem("verdict-theme", t), theme);
        // Every view starts with the principal disconnected (the app restores a connection made earlier in the session).
        await ctx.addInitScript(() => sessionStorage.removeItem("verdict.principal"));
        const page = await ctx.newPage();
        const select = async (scene: string) => {
          await page.goto(BASE);
          await page.locator("select").selectOption(scene);
          await page.waitForTimeout(400);
        };
        await page.goto(BASE);
        const scenes = await page
          .locator("select option")
          .evaluateAll((o) => o.map((x) => (x as unknown as { value: string }).value));
        const shot = (id: string) =>
          page.screenshot({ path: `${OUT}/${id}-${vp.name}-${theme}.png` });
        for (const scene of scenes) {
          if (only.length && !only.includes(scene)) continue;
          await select(scene);
          await shot(scene);
        }
        for (const ex of EXTRAS) {
          if (only.length && !only.includes(ex.id)) continue;
          await select(ex.scene);
          await ex.act(page);
          await page.waitForTimeout(500);
          await shot(ex.id);
        }
        await ctx.close();
      }
    }
    await browser.close();
    console.log(`screenshots in ${OUT}`);
  } finally {
    vite.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
