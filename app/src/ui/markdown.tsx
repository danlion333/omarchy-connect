import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, View, type TextStyle } from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

import { font, line, radius, size, space, type Palette } from '../theme'
import { usePalette } from '../state/ConnectionContext'
import { parseMarkdown, type Align, type Block, type Span } from '../lib/markdown'
import { sameMarkdown } from '../lib/transcript'
import { Mono } from './kit'

/**
 * What the agent wrote, drawn the way it was written.
 *
 * An agent's answer is markdown whether or not anything renders it, and read
 * raw on a phone the markup is pure cost: asterisks around the word that
 * mattered, a wall of pipes where a table was, and fenced code running off the
 * right edge in the same font as the prose around it. This is the other half —
 * the same text with its structure showing.
 *
 * The whole thing stays in the terminal's own type, at the kit's own sizes:
 * prose is `Body`, a heading is `Value` or `Title` in medium weight, code is
 * `Label`. This app is set in JetBrains Mono end to end and a proportional
 * heading in the middle of a monospace transcript reads as a different app, so
 * weight, colour and indentation carry the hierarchy that a font change would
 * carry elsewhere.
 */
function MarkdownView({ text, tone }: { text: string; tone?: string }) {
  const palette = usePalette()
  // Blocks arrive whole and are re-rendered on every push into the
  // conversation below them; parsing once per message keeps a long answer from
  // being re-read on each new tool call.
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <Blocks blocks={blocks} palette={palette} tone={tone} />
}

/**
 * The same text draws the same markdown.
 *
 * `Markdown` sits under every sentence in a transcript, and a transcript is
 * re-rendered by anything that touches the conversation around it — a draft
 * frame, a tool result, a block landing. Nothing about those changes what an
 * older message says, and re-running the parser and the whole block tree for
 * each of them is what a long chat pays for on every keystroke of the agent's.
 */
export const Markdown = React.memo(MarkdownView, sameMarkdown)

/**
 * The width of one character of body type.
 *
 * JetBrains Mono advances six tenths of its size, so a gutter measured in
 * characters lines up with the text beside it exactly — which is the whole
 * point of a hanging indent in a monospace face.
 */
const CH = size.body * 0.6

function Blocks({ blocks, palette, tone }: { blocks: Block[]; palette: Palette; tone?: string }) {
  return (
    <View style={{ gap: space.sm }}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} palette={palette} tone={tone} first={i === 0} />
      ))}
    </View>
  )
}

function BlockView({
  block,
  palette,
  tone,
  first,
}: {
  block: Block
  palette: Palette
  tone?: string
  first: boolean
}) {
  const body: TextStyle = {
    color: tone ?? palette.foreground,
    fontFamily: font.regular,
    fontSize: size.body,
    lineHeight: line.body,
  }

  switch (block.kind) {
    case 'paragraph':
      return (
        <Mono selectable style={body}>
          {render(block.spans, palette)}
        </Mono>
      )

    case 'heading': {
      // Three steps, not six: past the third level the difference stops being
      // legible at this size and the indentation of the content says more than
      // another point of type would. Medium rather than bold, because bold is
      // what a strong span is and a heading full of them must still read.
      const heading: TextStyle =
        block.level === 1
          ? { fontFamily: font.medium, fontSize: size.title, lineHeight: line.title }
          : block.level === 2
            ? { fontFamily: font.medium, fontSize: size.value, lineHeight: line.value }
            : { fontFamily: font.medium, fontSize: size.body, lineHeight: line.body }
      return (
        <Mono
          selectable
          style={[
            body,
            { color: block.level > 3 ? palette.light_foreground : palette.bright_foreground },
            heading,
            first ? null : { marginTop: space.xs },
          ]}
        >
          {render(block.spans, palette)}
        </Mono>
      )
    }

    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} palette={palette} />

    case 'quote':
      return (
        <View
          style={{
            borderLeftWidth: 2,
            borderLeftColor: palette.lighter_background,
            paddingLeft: space.md,
          }}
        >
          <Blocks blocks={block.blocks} palette={palette} tone={palette.light_foreground} />
        </View>
      )

    case 'list':
      return <ListView block={block} palette={palette} tone={tone} />

    case 'rule':
      return (
        <View
          style={{
            height: StyleSheet.hairlineWidth * 2,
            backgroundColor: palette.lighter_background,
            marginVertical: space.xs,
          }}
        />
      )

    case 'table':
      return <TableView block={block} palette={palette} tone={tone} />
  }
}

/* ── lists ───────────────────────────────────────────────────────────── */

/**
 * A bullet, its marker held in a column of its own.
 *
 * The marker sits in a fixed-width gutter rather than inline, so a wrapped
 * second line lands under the first word instead of under the bullet — which
 * on a screen this narrow is the difference between a list and a paragraph
 * with dots in it. The gutter is two characters for a bullet and as many as
 * the widest number needs for an ordered list, so every item's text starts on
 * the same column as it would in the terminal. Ordered lists number themselves
 * from the number the agent started at, because "3." in the middle of an
 * answer usually means the third step of something that began before this
 * message.
 */
function ListView({
  block,
  palette,
  tone,
}: {
  block: Block & { kind: 'list' }
  palette: Palette
  tone?: string
}) {
  const marker: TextStyle = {
    color: palette.light_foreground,
    fontFamily: font.regular,
    fontSize: size.body,
    lineHeight: line.body,
  }
  const width = Math.round((block.ordered ? String(block.start + block.items.length - 1).length + 2 : 2) * CH)

  return (
    <View style={{ gap: space.xs }}>
      {block.items.map((item, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          {item.checked === null ? (
            <Mono style={[marker, { width }]}>{block.ordered ? `${block.start + i}.` : '•'}</Mono>
          ) : (
            <View style={{ width, height: line.body, justifyContent: 'center', alignItems: 'flex-start' }}>
              <Feather
                name={item.checked ? 'check-square' : 'square'}
                size={12}
                color={item.checked ? palette.green : palette.light_foreground}
              />
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Blocks
              blocks={item.blocks}
              palette={palette}
              tone={item.checked ? palette.light_foreground : tone}
            />
          </View>
        </View>
      ))}
    </View>
  )
}

/* ── code ────────────────────────────────────────────────────────────── */

/**
 * A fenced block, kept as wide as it was written.
 *
 * Code is the one thing on this screen that must not reflow: a wrapped command
 * is a command you cannot read and must not paste. So it scrolls sideways
 * instead, and the copy button beside the language is there because selecting
 * text inside a scrolling box on a phone is a small ordeal and copying a
 * command to run it is the whole point of reading one here.
 */
function CodeBlock({ lang, text, palette }: { lang: string; text: string; palette: Palette }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(() => {
    void Clipboard.setStringAsync(text)
    void Haptics.selectionAsync().catch(() => {})
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }, [text])

  return (
    <View
      style={{
        backgroundColor: palette.darker_background,
        borderColor: palette.lighter_background,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderRadius: radius.sm,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: space.md,
          paddingRight: space.xs,
          minHeight: 32,
          backgroundColor: palette.dark_background,
        }}
      >
        <Mono
          style={{
            flex: 1,
            color: palette.muted,
            fontFamily: font.medium,
            fontSize: size.micro,
            lineHeight: line.micro,
            letterSpacing: 1.2,
            textTransform: 'uppercase',
          }}
          numberOfLines={1}
        >
          {lang || 'code'}
        </Mono>
        <Pressable
          onPress={copy}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy the code'}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.xs,
            minHeight: 28,
            paddingHorizontal: space.sm,
            borderRadius: radius.sm,
            backgroundColor: pressed ? palette.selection : 'transparent',
          })}
        >
          <Feather name={copied ? 'check' : 'copy'} size={13} color={copied ? palette.green : palette.light_foreground} />
          {copied ? (
            <Mono style={{ color: palette.green, fontFamily: font.regular, fontSize: size.micro, lineHeight: line.micro }}>
              copied
            </Mono>
          ) : null}
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Mono
          selectable
          style={{
            color: palette.light_foreground,
            fontFamily: font.regular,
            fontSize: size.label,
            lineHeight: line.label,
            padding: space.md,
          }}
        >
          {text}
        </Mono>
      </ScrollView>
    </View>
  )
}

/* ── tables ──────────────────────────────────────────────────────────── */

/**
 * A table, as wide as its columns need and no narrower.
 *
 * A cell that wraps loses the one thing a table is for, which is reading down
 * a column; so cells keep their width and the whole table scrolls sideways
 * when a phone cannot hold it, with the first column pinned in the eye by
 * being where scrolling starts. Each column is as wide as its longest cell,
 * up to a cap that keeps one verbose cell from dragging the rest off screen.
 */
function TableView({
  block,
  palette,
  tone,
}: {
  block: Block & { kind: 'table' }
  palette: Palette
  tone?: string
}) {
  const columns = Math.max(block.head.length, ...block.rows.map((row) => row.length), 1)
  const cell: TextStyle = { fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }
  // A column is as wide as its widest cell, in characters of label type, with
  // room to breathe — capped so a paragraph in a cell wraps there instead of
  // pushing every other column past the edge.
  const ch = size.label * 0.6
  const widths = Array.from({ length: columns }, (_, c) => {
    const longest = Math.max(
      spanLength(block.head[c] || []),
      ...block.rows.map((row) => spanLength(row[c] || [])),
      3,
    )
    return Math.min(longest, 34) * ch + space.sm * 2
  })

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
      <View
        style={{
          borderColor: palette.lighter_background,
          borderWidth: StyleSheet.hairlineWidth * 2,
          borderRadius: radius.sm,
          overflow: 'hidden',
        }}
      >
        <View style={{ flexDirection: 'row', backgroundColor: palette.dark_background }}>
          {Array.from({ length: columns }, (_, c) => (
            <Cell
              key={c}
              spans={block.head[c] || []}
              align={block.align[c] || 'left'}
              width={widths[c]}
              palette={palette}
              style={[cell, { color: palette.bright_foreground, fontFamily: font.medium }]}
            />
          ))}
        </View>
        {block.rows.map((row, r) => (
          <View
            key={r}
            style={{
              flexDirection: 'row',
              borderTopWidth: StyleSheet.hairlineWidth * 2,
              borderTopColor: palette.lighter_background,
            }}
          >
            {Array.from({ length: columns }, (_, c) => (
              <Cell
                key={c}
                spans={row[c] || []}
                align={block.align[c] || 'left'}
                width={widths[c]}
                palette={palette}
                style={[cell, { color: tone ?? palette.foreground }]}
              />
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

/** How many characters a cell would take on one line, markup removed. */
function spanLength(spans: Span[]): number {
  return spans.reduce(
    (n, span) => n + (span.kind === 'text' || span.kind === 'code' ? span.text.length : spanLength(span.spans)),
    0,
  )
}

function Cell({
  spans,
  align,
  width,
  palette,
  style,
}: {
  spans: Span[]
  align: Align
  width: number
  palette: Palette
  style: TextStyle[]
}) {
  const flat = StyleSheet.flatten(style)
  return (
    <View style={{ width, paddingHorizontal: space.sm, paddingVertical: space.xs + 2, justifyContent: 'center' }}>
      <Mono selectable style={[flat, { textAlign: align }]}>
        {render(spans, palette)}
      </Mono>
    </View>
  )
}

/* ── inline ──────────────────────────────────────────────────────────── */

/**
 * Inline markup, as nested text.
 *
 * Everything comes out of one `Text`, so a bold word in the middle of a
 * sentence wraps with the sentence instead of being its own box. Emphasis is
 * carried by weight and colour rather than by italics alone — a monospace
 * italic at 13 points is a guess, not a signal.
 */
function render(spans: Span[], palette: Palette): React.ReactNode[] {
  return spans.map((span, i) => {
    switch (span.kind) {
      case 'text':
        return span.text

      case 'code':
        return (
          <Mono
            key={i}
            style={{
              fontFamily: font.regular,
              color: palette.cyan,
              backgroundColor: palette.darker_background,
              borderRadius: radius.sm,
            }}
          >
            {span.text}
          </Mono>
        )

      case 'strong':
        return (
          <Mono key={i} style={{ fontFamily: font.bold, color: palette.bright_foreground }}>
            {render(span.spans, palette)}
          </Mono>
        )

      case 'em':
        return (
          <Mono key={i} style={{ fontStyle: 'italic', color: palette.light_foreground }}>
            {render(span.spans, palette)}
          </Mono>
        )

      case 'strike':
        return (
          <Mono key={i} style={{ textDecorationLine: 'line-through', color: palette.muted }}>
            {render(span.spans, palette)}
          </Mono>
        )

      case 'link':
        return (
          <Mono
            key={i}
            style={{ color: palette.blue, textDecorationLine: 'underline' }}
            onPress={() => void Linking.openURL(span.href).catch(() => {})}
            // A link's address is the half that says whether it is worth
            // opening, and a phone has nowhere to hover.
            onLongPress={() => {
              void Clipboard.setStringAsync(span.href)
              void Haptics.selectionAsync().catch(() => {})
            }}
          >
            {render(span.spans, palette)}
          </Mono>
        )
    }
  })
}
