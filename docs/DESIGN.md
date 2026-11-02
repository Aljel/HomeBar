# HomeBar — design direction v2: «Светлый дом» (light, minimal, homey)

v1 («Ночной гербарий», dark walnut, brass, herbarium jargon) was **rejected** by the owner:
"looks awful, buttons are terrible, the herbarium slang must go". What they want:
- a relatively **light background photo** combining wood and foliage, a cosy home feel;
- a **feed** (лента) with **minimalist design, thin lines and outlines**.

UI language: plain, warm, everyday **Russian**. No pseudo-Latin, no "specimen №", no "семена/SEMINA",
no "засушенное", no "collected", no typewriter labels, no herbarium metaphors anywhere (code identifiers may stay,
but nothing user-visible).

## Background
`frontend/public/bg/home-wide.webp` (2400×1350, desktop), `home-tall.webp` (1080×1920, portrait/phones),
`home-tiny.webp` (32px blurred placeholder). Photo: Unsplash `Ihh0nT34AJs` (Unsplash License) — warm bright living
room with hanging pothos, fern, rattan chair, wooden shelf, fairy lights. Credit it subtly in the footer
("Фото: Unsplash" linking to https://unsplash.com/photos/Ihh0nT34AJs).
- One fixed full-viewport layer (`position: fixed; inset: 0; z-index: -1`), `object-fit: cover`, `<picture>` with
  media query for portrait vs landscape, the tiny one as instant blurred placeholder/background-color fallback.
- Over it a warm light wash (e.g. `linear-gradient(rgba(250,247,241,.78), rgba(250,247,241,.90))`) so text stays
  readable; the photo should still be clearly recognisable around the content column, especially at the top
  (hero area can show more of the photo — lighter wash).
- Performance: no `backdrop-filter` on repeated feed cards (expensive while scrolling). Allowed only on the single
  sticky header. Cards use a solid/near-solid warm white surface.

## Visual language
- **Thin lines**: 1px hairline borders (`--line: rgba(58,46,34,.14)`, stronger `--line-strong: rgba(58,46,34,.28)`),
  thin dividers between items, outline icons with 1.5px stroke (inline SVG, lucide-like — write a tiny local icon set,
  no icon library dependency unless tree-shaken and tiny).
- **Buttons** (the owner hated v1 buttons — get these right): quiet and precise.
  - default: transparent, 1px `--line-strong` border, radius 999px (pill) or 10px — pick one and use it everywhere,
    height 36px (44px touch target on phones via padding/hit area), 14px medium text, icon + label, hover = subtle
    fill `rgba(58,46,34,.05)` + darker border; focus-visible ring.
  - primary: solid deep green (`--green-700 #2f4a3a`) with off-white text, same geometry. Max one primary per view.
  - icon-only buttons: 36px circle, 1px border or borderless, tooltip/aria-label.
  - no gradients, no glow, no heavy shadows, no brass, no skeuomorphism.
- **Palette**: warm off-white surfaces `#fbf8f3` / `#f4efe7`, ink `#2a241e`, muted `#6f655a`, wood accent
  `#a0714a` (sparingly: small details, active nav underline), leaf green `#2f4a3a` / `#5e7d5f`, favourite heart
  `#c2574a`, error `#a83a3a`. Light theme only. WCAG AA contrast.
- **Typography** (Cyrillic, bundled with @fontsource): one clean sans for UI and body — **Manrope** (or Inter) —
  weights 400/500/600; optional elegant serif only for big titles (Cormorant Garamond 500/600 is already a dependency;
  use it only for page titles and recipe titles if it looks good, otherwise drop it). Drop JetBrains Mono unless
  used for amounts (tabular numbers can come from Manrope `font-variant-numeric: tabular-nums`).
- **Radius** 14–18px for cards/images, generous whitespace, calm.
- **Recipe placeholder art** (no photo): a thin-outline line drawing of the glass by `glass`/kind (rocks, coupe,
  martini, highball/collins, wine, mug/hot, plate/bowl for dishes) on a soft tinted background (very light green or
  sand, derived from the recipe id). Same 1.5px stroke style as icons. No pressed plants.
- Motion: subtle (opacity/translate 150–250ms), respect `prefers-reduced-motion`. No fireflies, no vines.

## Layout & screens
- **Header**: sticky, slim (56px), light frosted, hairline bottom border. Left: "HomeBar" wordmark (maybe with a tiny
  outline leaf icon). Centre/right: text nav links (Лента · Рецепты · Попробуйте · Меню · Стойка (host) · О баре),
  active link = thin underline in wood accent. Right: login icon button (outline key/user icon), when logged in a small
  "Хозяин" label + logout. Phones: compact bar + menu button opening a simple sheet with the links.
- **`/` = Лента (feed)** — the main page:
  - short hero: title from the editable `home` page (markdown, first heading/paragraphs, keep it short, "читать
    дальше" → /about if long), stats in a single thin line ("9 рецептов · 7 коктейлей · 2 избранных"), two buttons:
    "Меню на сегодня" (primary) and "Все рецепты".
  - filter chips row (thin outline chips): Всё · Коктейли · Блюда · Избранное · Мои · Из интернета.
  - the feed: centred single column (~640px) on desktop with an optional sticky right sidebar on ≥1100px
    (active menu preview, popular tags, link to "Попробуйте"); single column on phones.
  - feed cards: image (photo or line-art placeholder) 16:10 with rounded corners, title, one-line description,
    ingredient line "Джин · Кампари · Красный вермут" muted, small meta (kind, glass), footer row of outline icon
    buttons: ♡ favourite (host), + в меню (host), open. Hairline border card OR borderless items separated by thin
    dividers — choose what looks most refined.
  - interleave **"Попробуйте"** items from `/api/discover/random` (kind according to filter, cocktails by default)
    every ~4 own recipes, labelled with a small outline badge "Из интернета", with "Сохранить себе" (host, import) or
    "уже сохранено" link. At the end of the feed a "Ещё идеи" button loads another random batch (append).
  - Use `content-visibility: auto` + `contain-intrinsic-size` on cards for long feeds.
- **`/recipes`** — compact searchable list/grid (search input with thin underline style, filters, tags), same card
  style but denser (thumbnail left, text right in list mode on phones).
- **`/recipes/:id`** — clean article: photo/placeholder, title, description, actions row (outline buttons:
  История, В избранное, В меню, Вариация, Править; delete as a quiet icon button with confirm). Ingredients as a
  table-like list with thin dividers, amounts right-aligned tabular; servings stepper (− 2 +, thin outline) and ml/oz
  segmented control (thin outline). **Proportions visual**: keep the idea but minimal — a thin-outline glass
  silhouette with horizontal strata lines/soft fills whose heights ∝ volume share, plus/or a single thin stacked bar
  with labelled segments; hover/focus sync with ingredient rows stays. Instructions as readable markdown. Versions
  drawer restyled minimal.
- **Editor** — clean form: labels above inputs, 1px borders, 10px radius, plenty of space; ingredient rows compact.
- **`/discover` «Попробуйте»** — same feed card style (no seed packets / flip cards), kind switch (Коктейли/Блюда),
  search, "Ещё идеи".
- **`/menu` (guests, phones!)** — "Меню на сегодня": clean list with thumbnails and thin dividers, big tap rows,
  bottom sheet with ingredients + order form (name remembered, note), "Мои заказы" with simple status pills
  (Принят / Готовится / Готово / Отменён).
- **`/bar` (host)** — order queue in two/three columns, simple cards with hairline borders, status buttons,
  chime + subtle highlight on new orders; menu management restyled.
- **`/about`** — editable markdown article.
- States: skeletons (light shimmer, stable layout), empty states with a thin line illustration + one action,
  errors with retry; toasts minimal (white, hairline border, small shadow).
