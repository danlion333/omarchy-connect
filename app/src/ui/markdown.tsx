import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from 'react-native'
import { Feather } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'

import { alpha, font, radius, size, space, type Palette } from '../theme'
import { usePalette } from '../state/ConnectionContext'
import { parseMarkdown, type Align, type Block, type Span } from '../lib/markdown'

/**
 * What the agent wrote, drawn the way it was written.
 *
 * An agent's answer is markdown whether or not anything renders it, and read
 * raw on a phone the markup is pure cost: asterisks around the word that
 * mattered, a wall of pipes where a table was, and fenced code running off the
 * right edge in the same font as the prose around it. This is the other half —
 * the same text with its structure showing.
 *
 * The whole thing stays in the terminal's own type. This app is set in
 * JetBrains Mono end to end and a proportional heading in the middle of a
 * monospace transcript reads as a different app, so weight, colour and
 * indentation carry the hierarchy that a font change would carry elsewhere.
 */
export function Markdown({ text, tone }: { text: string; tone?: string }) {
  const palette = usePalette()
  // Blocks arrive whole and are re-rendered on every push into the
  // conversation below them; parsing once per message keeps a long answer from
  // being re-read on each new tool call.
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <Blocks blocks={blocks} palette={palette} tone={tone} />
}

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
    lineHeight: 21,
  }

  switch (block.kind) {
    case 'paragraph':
      return (
        <Text selectable style={body}>
          {render(block.spans, palette)}
        </Text>
      )

    case 'heading': {
      // Three steps, not six: past the third level the difference stops being
      // legible at this size and the indentation of the content says more than
      // another point of type would.
      const heading: TextStyle =
        block.level === 1
          ? { fontFamily: font.bold, fontSize: size.value + 3, lineHeight: 24 }
          : block.level === 2
            ? { fontFamily: font.bold, fontSize: size.value, lineHeight: 21 }
            : { fontFamily: font.medium, fontSize: size.body, lineHeight: 20 }
      return (
        <Text
          selectable
          style={[
            body,
            { color: block.level > 3 ? palette.light_foreground : palette.bright_foreground },
            heading,
            first ? null : { marginTop: space.xs },
          ]}
        >
          {render(block.spans, palette)}
        </Text>
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
 * with dots in it. Ordered lists number themselves from the number the agent
 * started at, because "3." in the middle of an answer usually means the third
 * step of something that began before this message.
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
    color: palette.muted,
    fontFamily: font.regular,
    fontSize: size.body,
    lineHeight: 21,
  }
  // Wide enough for the marker *and* the space after it. A checkbox is drawn
  // rather than typed, so it has to be told to leave that space; a bullet
  // sitting in the same column keeps the two kinds of item lined up.
  const width = block.ordered ? 8 + String(block.start + block.items.length).length * 8 : 18

  return (
    <View style={{ gap: space.xs }}>
      {block.items.map((item, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
          {item.checked === null ? (
            <Text style={[marker, { width }]}>{block.ordered ? `${block.start + i}.` : '•'}</Text>
          ) : (
            <View style={{ width, paddingTop: 4, alignItems: 'flex-start' }}>
              <Feather
                name={item.checked ? 'check-square' : 'square'}
                size={12}
                color={item.checked ? palette.green : palette.muted}
              />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Blocks
              blocks={item.blocks}
              palette={palette}
              tone={item.checked ? palette.muted : tone}
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
          paddingHorizontal: space.sm,
          paddingVertical: space.xs,
          backgroundColor: palette.dark_background,
        }}
      >
        <Text
          style={{
            flex: 1,
            color: palette.muted,
            fontFamily: font.regular,
            fontSize: size.micro,
            letterSpacing: 1,
          }}
          numberOfLines={1}
        >
          {lang || 'code'}
        </Text>
        <Pressable onPress={copy} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
          <Feather name={copied ? 'check' : 'copy'} size={12} color={copied ? palette.green : palette.muted} />
          {copied ? (
            <Text style={{ color: palette.green, fontFamily: font.regular, fontSize: size.micro }}>copied</Text>
          ) : null}
        </Pressable>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <Text
          selectable
          style={{
            color: palette.light_foreground,
            fontFamily: font.regular,
            fontSize: size.label,
            lineHeight: 18,
            padding: space.md,
          }}
        >
          {text}
        </Text>
      </ScrollView>
    </View>
  )
}

/* ── tables ──────────────────────────────────────────────────────────── */

/**
 * A table, made to fit rather than made to scroll.
 *
 * An agent's table is nearly always two or three short columns — a name and a
 * verdict — and those fit a phone if the cells are allowed to wrap. Wrapping
 * costs a couple of lines of height; scrolling sideways costs the reader the
 * column they were comparing against, which is the only reason the table was
 * drawn.
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
  const cell: TextStyle = { fontFamily: font.regular, fontSize: size.label, lineHeight: 17 }

  return (
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
              palette={palette}
              style={[cell, { color: tone ?? palette.foreground }]}
            />
          ))}
        </View>
      ))}
    </View>
  )
}

function Cell({
  spans,
  align,
  palette,
  style,
}: {
  spans: Span[]
  align: Align
  palette: Palette
  style: TextStyle[]
}) {
  const flat = StyleSheet.flatten(style)
  return (
    <View style={{ flex: 1, paddingHorizontal: space.sm, paddingVertical: space.xs, minWidth: 0 }}>
      <Text selectable style={[flat, { textAlign: align }]}>
        {render(spans, palette)}
      </Text>
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
 * italic at 14 points is a guess, not a signal.
 */
function render(spans: Span[], palette: Palette): React.ReactNode[] {
  return spans.map((span, i) => {
    switch (span.kind) {
      case 'text':
        return span.text

      case 'code':
        return (
          <Text
            key={i}
            style={{
              fontFamily: font.regular,
              color: palette.cyan,
              backgroundColor: alpha(palette.lighter_background, 0.55),
            }}
          >
            {span.text}
          </Text>
        )

      case 'strong':
        return (
          <Text key={i} style={{ fontFamily: font.bold, color: palette.bright_foreground }}>
            {render(span.spans, palette)}
          </Text>
        )

      case 'em':
        return (
          <Text key={i} style={{ fontStyle: 'italic', color: palette.light_foreground }}>
            {render(span.spans, palette)}
          </Text>
        )

      case 'strike':
        return (
          <Text key={i} style={{ textDecorationLine: 'line-through', color: palette.muted }}>
            {render(span.spans, palette)}
          </Text>
        )

      case 'link':
        return (
          <Text
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
          </Text>
        )
    }
  })
}
