import { describe, expect, it } from "vitest";
import { splitIntro } from "./intro";

describe("splitIntro", () => {
  it("takes the first heading and paragraph", () => {
    const r = splitIntro("# Мой бар\n\nПривет! Это бар.\n\n## Как это работает\n\n- меню\n- заказы");
    expect(r.heading).toBe("Мой бар");
    expect(r.lead).toBe("Привет! Это бар.");
    expect(r.rest).toBe("## Как это работает\n\n- меню\n- заказы");
  });
  it("works without a heading", () => {
    const r = splitIntro("Просто текст.\n\nЕщё абзац.");
    expect(r.heading).toBeNull();
    expect(r.lead).toBe("Просто текст.");
    expect(r.rest).toBe("Ещё абзац.");
  });
  it("skips a leading list when looking for the lead paragraph", () => {
    const r = splitIntro("- пункт\n\nАбзац");
    expect(r.lead).toBe("Абзац");
    expect(r.rest).toBe("- пункт");
  });
});
