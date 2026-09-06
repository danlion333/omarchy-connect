# How this app is drawn

The phone app is the Omarchy desktop, held in one hand: five **workspaces**
behind the desktop's own **bar** at the bottom, glass cards over a wallpaper,
one accent, JetBrains Mono for everything. That much is settled. This file is
about the rest: what goes on a screen, how big, in what words — the decisions
that were being made differently on every screen and that made the app read
like a debug console.

## The shell

| # | Workspace | Screen |
| --- | --- | --- |
| 1 | home | `HomeScreen` — what the desktop is doing and the controls that change it |
| 2 | agents | `AgentsScreen` |
| 3 | terminal | `TerminalScreen` — the phone as a keyboard for the desktop |
| 4 | share | `ShareScreen` |
| 5 | setup | `SettingsScreen` |

`App.tsx` owns the shell and nothing else: the workspaces side by side in one
paging `ScrollView` (a page mounts on first visit and stays mounted, each in
its own `ErrorBoundary`), the `Wallpaper` behind them, and the **Omarchy bar** —
five numbered buttons, the active one saying its name over an accent underline,
orange badges for agents waiting and for permissions not yet granted, and a
tray on the right with the link dot, wifi, notification silencing and the clock.
The tray goes to Setup. A screen never draws navigation, never draws the bar,
and never assumes it is the only thing on the phone.

Swiping moves between workspaces. A control with a horizontal gesture of its
own — `ChipRow`, `LevelBar`, a field — keeps it: the inner scroller and the
responder system take the drag before the pager sees it. Anything new with a
horizontal drag is tested against the pager before it ships.

## Glass

Cards are translucent over the wallpaper: `surface()` in `theme.ts` gives the
card and edge colours, `Card` reads them, and the **Transparency** switch on
Setup (`useLook()`) turns them solid and the wallpaper off. There is no real
blur — no `expo-blur`, no native dependency for the look. The wallpaper is
`aurora` (soft drifting lights in the theme's colours), `dots`, or `none`, and
it is a phone-local setting like transparency; everything else about the
colours comes from the desktop's theme.

Everything below is a rule unless it says "prefer". A screen that needs to
break one should say why in a comment.

## The one-glance test

A card is read in one glance, from a metre away, while doing something else.
So:

- **Every value fits on its row.** No "192.1…", no "Cloudf…". If a value does
  not fit beside its label at `size.value`, it gets a row of its own
  (`Row`, or `DataGrid` which now decides this itself). If it still does not
  fit, shorten the *formatting* — `7.1.9-arch1-2` not
  `7.1.9-arch1-2-g0a41bf1`, `Wi-Fi` not `Wi-Fi (MyNetworkName-5GHz)` with the
  SSID on its own row — never the meaning.
- **Headers are one line each.** `CardHeader` truncates its title and
  subtitle; give it a subtitle that fits in about 28 characters or none.
  `~/Downloads/Omarchy Connect` is a subtitle; "the app follows the desktop"
  is a paragraph and goes.
- **No paragraphs.** The only prose a card may carry is one `Hint`: two
  lines at most, saying what the reader must *do* or *know to act* ("Needs a
  sudo rule on the desktop", "Android only", "Off while on a remote link").
  Everything else — why a feature exists, what it costs, how it works — is
  README material and is deleted from the screen.
- **A number the reader came for is a `Stat` or `Hero`**, not a title. CPU
  load, volume, usage percentage. One or two per card, then the
  detail in `Row`s under a `Meter`.

## Type

| Role | Component | sp | Weight | Lines |
| --- | --- | --- | --- | --- |
| Section name, tile state, pill | `Caps` / `Pill` | 10 | medium, +1.2 tracking (pill +0.8), uppercase | 1 |
| Key in a key–value row, list subtitle, header subtitle, hint, chip | `Label` / `Hint` | 12 | regular | 1 (hint: 2) |
| Prose, button label | `Body` / `Button` | 13 | regular / medium | — |
| Value in a row, list title, field text, toggle label | `Value` | 14 | regular | 1 |
| Card title | `CardHeader` | 14 | bold | 1 |
| Screen title | `Title` / `ScreenHeader` | 16 | bold | 1 |
| Headline number | `Hero` / `Stat` | 28 | bold, tabular | 1 |

Never set `fontSize` from a literal. Use `size.*` with its `line.*`, and put
text through the kit components (or `Mono`) so the OS font multiplier is
capped at 1.2. Never render a bare `<Text>` from react-native in a screen.

Colours by role, from the palette: `bright_foreground` for values, titles and
list titles; `foreground` for prose and buttons; `light_foreground` for labels
and inactive controls; `muted` only for caps, hints and dividers — it is under
3:1 on the card background and must never carry a value.

## Layout

- Workspace padding 18 top / 16 sides / 24 bottom (`Screen` does it), card
  padding 14 with 10 between a card's children, cards 12 apart, corners 12.
  Controls the thumb lands on are `radius.ctl` (10), chips and tiles 8, pills
  round.
- Every screen starts with `ScreenHeader`: the workspace's name at 16 bold,
  one line of `sub` under it — who the desktop is, what it is wearing, how far
  away — with a `dot` where the link matters, and at most two `IconButton`s on
  the right.
- A card is: `CardHeader` → optional `Stat`/`Hero` + `Meter` or `Sparkline` →
  `Row`s or a list → optional controls (`Buttons`, `Tiles`, `ChipRow`,
  `Segmented`, `Field`) → optional `Hint`. Groups inside a card are separated
  by `Divider` and named with `Section`.
- Tap targets are 44dp (`touch`). Buttons in a row inside a card use `compact`
  (36dp, 12sp) inside `Buttons`. Icon-only actions are `IconButton` (36dp,
  borderless, `light_foreground`) with a `label` for the screen reader. Never
  a bare `Pressable` around an icon.
- Lists of things (windows, files, sessions, permissions) are `ListRow`s: 48dp,
  a hairline between them, `last` on the final one, `icon` on the left (`fill`
  for the live one), and one `IconButton` or `Pill` in `right` — never a
  sentence. A tappable row bleeds to the card's edge on its own.
- A grid of desktop switches is `Tiles` of `Tile` (label + a caps state);
  a single setting is a `Toggle` with the cost in its `hint`. A set of choices
  is `Segmented` when there are two to four peers, `Chips` when there are more
  and they wrap (themes), `ChipRow` when they scroll sideways (workspaces,
  terminal keys), `ListRow`s when each needs a subtitle.
- Something the desktop said verbatim — a command, a path, a clipboard — is
  `Code`. A number's recent history is `Sparkline`.

## Words

English, sentence case, no trailing full stop on a label or a hint. Buttons
are a verb or verb-object: "Send", "Copy on desktop", "Pair", "Try again".
Never "Click here", never a question as a button.

Caps strings are nouns: `SESSION`, `2 WINDOWS`, `DNS PROVIDER`. A caps string
over 28 characters wraps, so it is wrong.

Cut anything that explains the product to its owner. The reader installed the
daemon; they know what a tunnel is. Say the state, then the one thing that
changes it.

## States every screen has

Each screen has all five, drawn deliberately, and an agent redesigning a
screen checks each one by forcing it:

1. **Loading, first time** — a skeleton or an `ActivityIndicator` inside the
   card, never a blank card and never a spinner over the whole screen.
2. **Loading, again** — the `IconButton` in the header spins (`loading`);
   the old data stays on screen. Pull-to-refresh where the screen is a list.
3. **Empty** — `Empty` with an icon, one sentence, and the action that fills
   it, if there is one: "No files yet · Send one from the desktop with
   `omarchy-connect send`".
4. **Failed** — `Notice` with the thrown value (never a string you made from
   it), `tone` by meaning, and `action` when there is a retry. The notice sits
   where the failed content would have been, not at the top of the screen.
   Detail (the stack) stays behind the tap `Notice` already provides.
5. **Not possible here** — a capability the desktop lacks, a platform that
   cannot (iOS, Expo Go), a remote link that disables telephony. The card is
   still drawn, dimmed (`dim` on the `Card`, or `tone={palette.muted}` on the
   header), with one `Hint` saying why and, when there is one, what to do about it. Never an
   empty card, never a card that silently disappears.

## Saying what happened

Every command the phone sends the desktop says so, once, in a `useToast()`:
the command or the action as `value`, what happened as `hint` ("ran on
desktop", "on · ran on desktop"). One at a time, 2.4 seconds, no buttons. A
screen never leaves a tap unanswered and never answers one with a full-screen
spinner.

Destructive actions — suspend, reboot, shut down, unpair, close a window, kill
an agent — ask first with `useConfirm()`, which returns a promise: the title is
the verb as a question ("Shut down the desktop?"), the detail is the command
that will run, the destructive button carries the verb. It **replaces**
`Alert.alert`; nothing in a screen reaches for react-native's alert any more,
and nothing else confirms.

## Errors, specifically

`lib/errors.ts` turns anything thrown into `{ message, detail }`. Screens do
not build messages; they hand the thrown value to `Notice`. Where a message is
too raw for a person (a Java exception name, an HTTP status), fix it in
`lib/errors.ts`'s table so every screen benefits — not with a string in the
screen.

A failure a reader can do nothing about (the desktop's own complaint) is a
`warning`. A failure that stopped what they asked for is an `error`. A note
that something was skipped for their own good ("Telephony off on a remote
link") is `info`, and usually a `Hint` instead.

## Doing a screen

- Redesign one screen at a time, in its own worktree and branch. Own only
  that screen's file(s). `theme.ts`, `kit.tsx`, `look.tsx`, `agentkit.tsx`,
  `App.tsx`, `lib/*`, `api/*`, `state/*` belong to nobody's screen branch: if a
  primitive is missing, write it at the bottom of the screen file as a local
  component and say so in the report, so it can be lifted into the kit once.
  A screen never edits the shell to make room for itself.
- Behaviour is not the brief. Every call the screen makes, every capability
  it checks, every state it tracks stays. This is layout, type and words.
- `npx tsc --noEmit` and `npm test` from `app/` must stay green.
- Every state above is looked at, on the phone or by forcing it in code, and
  the report says which ones were seen.
