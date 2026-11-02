/** Splits a markdown page into a short hero intro: first heading + first paragraph, and the rest. */
export interface Intro {
  heading: string | null;
  lead: string;
  rest: string;
}

export function splitIntro(md: string): Intro {
  const blocks = md
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);
  let heading: string | null = null;
  let lead = "";
  const rest: string[] = [];
  for (const b of blocks) {
    const h = /^#{1,3}\s+(.+)$/.exec(b);
    if (heading === null && !lead && h && !b.includes("\n")) heading = h[1]!.trim();
    else if (!lead && !/^(#|[-*+]\s|>|\d+\.\s|```|\|)/.test(b)) lead = b;
    else rest.push(b);
  }
  return { heading, lead, rest: rest.join("\n\n") };
}
