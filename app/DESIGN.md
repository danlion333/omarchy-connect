# How this app is drawn

The phone app is a status card from the Omarchy bar, held in one hand. Dark
ground, one accent, JetBrains Mono for everything. That much is settled. This
file is about the rest: what goes on a screen, how big, in what words — the
decisions that were being made differently on every screen and that made the
app read like a debug console.

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
  load, volume, brightness, usage percentage. One or two per card, then the
  detail in `Row`s under a `Meter`.

## Type

| Role | Component | sp | Weight | Lines |
| --- | --- | --- | --- | --- |
| Screen name, section name, card subtitle | `Caps` | 10 | medium, +1.2 tracking, uppercase | 1 |
| Key in a key–value row, list subtitle, hint | `Label` / `Hint` | 12 | regular | 1 (hint: 2) |
| Prose, button label, notice | `Body` / `Button` | 13 | regular / medium | — |
| Value in a row, list title, field text | `Value` | 14 | regular | 1 |
| Card title | `Title` | 16 | bold | 1 |
| Headline number | `Hero` / `Stat` | 28 | bold | 1 |

Never set `fontSize` from a literal. Use `size.*` with its `line.*`, and put
text through the kit components (or `Mono`) so the OS font multiplier is
capped at 1.2. Never render a bare `<Text>` from react-native in a screen.

Colours by role, from the palette: `bright_foreground` for values, titles and
list titles; `foreground` for prose and buttons; `light_foreground` for labels
and inactive controls; `muted` only for caps, hints and dividers — it is under
3:1 on the card background and must never carry a value.

## Layout

- Screen padding 16, card padding 14, cards 12 apart, `radius.md` corners.
- Every screen starts with `ScreenHeader`: the tab's name in caps, the link's
  state beside it only where that matters (Stats, Setup), and at most two
  actions on the right (an `IconButton`, never a text button).
- A card is: `CardHeader` → optional `Stat` row or `Meter` → `Row`s or a list
  → optional controls → optional `Hint`. Groups inside a card are separated by
  `Divider` and named with `Section`.
- Tap targets are 44dp (`touch`). Buttons in a row inside a card use
  `compact`. Icon-only actions are `IconButton` with a `label` for the screen
  reader. Never a bare `Pressable` around an icon.
- Lists of things (windows, files, sessions, skills) are `ListRow`s with a
  hairline between them and `last` on the final one; the row's `right` slot
  holds one `IconButton` or one `Pill`, not a sentence.
- A set of choices is `Segmented` when there are two to four and they are
  peers (DNS provider), `Chip`s in a wrapping row when there are more
  (themes), a list of `ListRow`s when each needs a subtitle.
- Boolean settings are `Toggle`, with the cost in its `hint`, not a pair of
  buttons and a paragraph.

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
   still drawn, dimmed (`tone={palette.muted}` on the header), with one
   `Hint` saying why and, when there is one, what to do about it. Never an
   empty card, never a card that silently disappears.

Destructive actions — reboot, shut down, unpair, kill an agent — confirm with
`Alert.alert` from react-native, title as the verb ("Shut down the desktop?"),
the destructive button styled `destructive`. Nothing else confirms.

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
  that screen's file(s). `theme.ts`, `kit.tsx`, `agentkit.tsx`, `lib/*`,
  `api/*`, `state/*` belong to nobody's screen branch: if a primitive is
  missing, write it at the bottom of the screen file as a local component
  and say so in the report, so it can be lifted into the kit once.
- Behaviour is not the brief. Every call the screen makes, every capability
  it checks, every state it tracks stays. This is layout, type and words.
- `npx tsc --noEmit` and `npm test` from `app/` must stay green.
- Every state above is looked at, on the phone or by forcing it in code, and
  the report says which ones were seen.
