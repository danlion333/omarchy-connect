import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type GestureResponderEvent,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as Sharing from 'expo-sharing'
import { File } from 'expo-file-system'

import { useConnection } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Divider, Empty, ListRow, Screen, Value } from '../ui/kit'
import { bytes, clock } from '../lib/format'
import { downloadOffer } from '../lib/download'
import { saveToGallery } from '../lib/gallery'
import { iconFor, mediaKind } from '../lib/media'
import { alpha, font, radius, size, space } from '../theme'

type InboxItem = { name: string; size: number; at: number }
type StandingOffer = { token: string; name: string; size: number; expiresAt: number }
type Offer = { token: string; name: string; size: number; at?: number }

/** One finger, as the responder system hands it over. */
type NativeTouch = { locationX: number; locationY: number }

/**
 * How large a picture may be before the phone stops fetching it on sight.
 * A preview costs the whole file — there is no thumbnail endpoint — so above
 * this the thumbnail waits for a tap rather than eating a scan of the LAN.
 */
const PREVIEW_MAX = 24 * 1024 * 1024

const THUMB = 52

export function ShareScreen() {
  const { call, client, clipboard, files, palette, status } = useConnection()
  const [draft, setDraft] = useState('')
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [standing, setStanding] = useState<StandingOffer[]>([])
  const [local, setLocal] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, true>>({})
  const [viewing, setViewing] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const connected = status === 'connected'

  const loadInbox = useCallback(async () => {
    if (!connected) return
    try {
      const res = await call<{ items: InboxItem[] }>('share.inbox', { limit: 15 })
      setInbox(res.items)
    } catch {
      /* inbox is a nicety, not a requirement */
    }
  }, [call, connected])

  /**
   * Offers the desktop made while the phone was elsewhere. The live `ev:file`
   * frames only reach a phone that is listening, so without this a photo sent
   * before the app was opened would be invisible until it expired.
   */
  const loadOffers = useCallback(async () => {
    if (!connected) return
    try {
      const res = await call<{ offers: StandingOffer[] }>('share.offers')
      setStanding(res.offers)
    } catch {
      /* an older daemon may not answer this */
    }
  }, [call, connected])

  useEffect(() => {
    loadInbox()
  }, [loadInbox, files.length])

  useEffect(() => {
    loadOffers()
  }, [loadOffers, files.length])

  const report = (message: string) => {
    setNote(message)
    setError(null)
    setTimeout(() => setNote(null), 4000)
  }

  const fail = (err: unknown) => {
    setError((err as Error).message)
    setNote(null)
  }

  /* ── clipboard ─────────────────────────────────────────────────────── */

  const pushClipboard = useCallback(async () => {
    setBusy('push')
    try {
      const text = await Clipboard.getStringAsync()
      if (!text) {
        report('the phone clipboard is empty')
        return
      }
      await call('clipboard.set', { text })
      report('sent to the desktop clipboard')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }, [call])

  const pullClipboard = useCallback(async () => {
    setBusy('pull')
    try {
      const res = await call<{ text: string; kind: string }>('clipboard.get')
      if (res.kind !== 'text' || !res.text) {
        report('the desktop clipboard holds no text')
        return
      }
      await Clipboard.setStringAsync(res.text)
      report('copied to the phone clipboard')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }, [call])

  /* ── text ──────────────────────────────────────────────────────────── */

  const sendText = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setBusy('text')
    try {
      const isUrl = /^https?:\/\/\S+$/i.test(text)
      if (isUrl) {
        await call('system.openUrl', { url: text })
        report('opened on the desktop')
      } else {
        await call('share.text', { text, action: 'clipboard' })
        report('copied on the desktop')
      }
      setDraft('')
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }, [call, draft])

  /* ── files out ─────────────────────────────────────────────────────── */

  const upload = useCallback(
    async (uri: string, name: string) => {
      if (!client) throw new Error('not connected')
      const result = await new File(uri).upload(`${client.baseUrl}/api/upload`, {
        httpMethod: 'POST',
        headers: client.uploadHeaders(name),
      })
      if (result.status >= 400) throw new Error(`the desktop refused the file (${result.status})`)
      return JSON.parse(result.body || '{}')
    },
    [client],
  )

  const pickDocument = useCallback(async () => {
    setBusy('file')
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true })
      if (picked.canceled) return
      const asset = picked.assets[0]
      await upload(asset.uri, asset.name)
      report(`sent ${asset.name}`)
      loadInbox()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }, [loadInbox, upload])

  const pickPhoto = useCallback(async () => {
    setBusy('photo')
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!permission.granted) {
        report('photo access was denied')
        return
      }
      const picked = await ImagePicker.launchImageLibraryAsync({ quality: 1 })
      if (picked.canceled) return
      const asset = picked.assets[0]
      const name = asset.fileName || `photo-${Date.now()}.jpg`
      await upload(asset.uri, name)
      report(`sent ${name}`)
      loadInbox()
    } catch (err) {
      fail(err)
    } finally {
      setBusy(null)
    }
  }, [loadInbox, upload])

  /* ── files in ──────────────────────────────────────────────────────── */

  /**
   * The offers worth showing: whatever arrived live, newest first, then the
   * ones the daemon was still holding when we asked. A token appears once.
   */
  const offers = useMemo<Offer[]>(() => {
    const seen = new Map<string, Offer>()
    for (const file of files) {
      if (file.direction === 'out' && file.token && !seen.has(file.token)) {
        seen.set(file.token, { token: file.token, name: file.name, size: file.size, at: file.at })
      }
    }
    for (const offer of [...standing].sort((a, b) => b.expiresAt - a.expiresAt)) {
      if (!seen.has(offer.token)) seen.set(offer.token, { token: offer.token, name: offer.name, size: offer.size })
    }
    return [...seen.values()]
  }, [files, standing])

  /**
   * One download per offer, however many buttons ask for it. The promise is
   * the memo: a preview that is still crossing and a Save tapped on top of it
   * end up sharing the same bytes instead of racing for the same filename.
   */
  const fetching = useRef(new Map<string, Promise<string>>())

  const fetchOffer = useCallback(
    (token: string, name: string) => {
      const running = fetching.current.get(token)
      if (running) return running
      const job = (async () => {
        if (!client) throw new Error('not connected')
        const uri = await downloadOffer(client.downloadUrl(token), token, name)
        setLocal((prev) => ({ ...prev, [token]: uri }))
        return uri
      })()
      // A failed fetch is forgotten, so the next tap is allowed to try again.
      job.catch(() => fetching.current.delete(token))
      fetching.current.set(token, job)
      return job
    },
    [client],
  )

  // Pictures fetch themselves, so the card can show what it is holding rather
  // than a filename. Anything too large waits to be asked for.
  useEffect(() => {
    if (!client) return
    for (const offer of offers) {
      if (mediaKind(offer.name) !== 'image') continue
      if (offer.size > PREVIEW_MAX) continue
      if (fetching.current.has(offer.token)) continue
      fetchOffer(offer.token, offer.name).catch(() => {})
    }
  }, [client, fetchOffer, offers])

  const saveOffer = useCallback(
    async (offer: Offer) => {
      setBusy(`save:${offer.token}`)
      try {
        const uri = await fetchOffer(offer.token, offer.name)
        await saveToGallery(uri)
        setSaved((prev) => ({ ...prev, [offer.token]: true }))
        report(`${offer.name} is in your gallery`)
      } catch (err) {
        fail(err)
      } finally {
        setBusy(null)
      }
    },
    [fetchOffer],
  )

  const shareOffer = useCallback(
    async (offer: Offer) => {
      setBusy(`share:${offer.token}`)
      try {
        const uri = await fetchOffer(offer.token, offer.name)
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
        else report(`saved to ${uri}`)
      } catch (err) {
        fail(err)
      } finally {
        setBusy(null)
      }
    },
    [fetchOffer],
  )

  const openOffer = useCallback(
    async (offer: Offer) => {
      if (mediaKind(offer.name) !== 'image') {
        shareOffer(offer)
        return
      }
      if (!local[offer.token]) {
        setBusy(`open:${offer.token}`)
        try {
          await fetchOffer(offer.token, offer.name)
        } catch (err) {
          fail(err)
          return
        } finally {
          setBusy(null)
        }
      }
      setViewing(offer.token)
    },
    [fetchOffer, local, shareOffer],
  )

  const viewed = offers.find((offer) => offer.token === viewing) ?? null

  return (
    <Screen>
      <Caps style={{ marginBottom: space.md }}>Share</Caps>

      {note ? (
        <Body tone={palette.green} style={{ marginBottom: space.md, fontSize: size.label }}>
          {note}
        </Body>
      ) : null}
      {error ? (
        <Body tone={palette.red} style={{ marginBottom: space.md, fontSize: size.label }}>
          {error}
        </Body>
      ) : null}

      <Card>
        <CardHeader
          icon="clipboard"
          title="Clipboard"
          subtitle={clipboard ? `desktop copied ${clock(clipboard.at)}` : 'not synced yet'}
        />
        {clipboard?.text ? (
          <Body tone={palette.foreground} style={{ marginBottom: space.md }} >
            {clipboard.text.length > 240 ? `${clipboard.text.slice(0, 240)}…` : clipboard.text}
          </Body>
        ) : (
          <Body tone={palette.muted} style={{ marginBottom: space.md, fontSize: size.label }}>
            Anything you copy on the desktop shows up here.
          </Body>
        )}
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Button
            icon="arrow-down"
            label="From desktop"
            onPress={pullClipboard}
            loading={busy === 'pull'}
            disabled={!connected}
            style={{ flex: 1 }}
          />
          <Button
            icon="arrow-up"
            label="From phone"
            onPress={pushClipboard}
            loading={busy === 'push'}
            disabled={!connected}
            style={{ flex: 1 }}
          />
        </View>
      </Card>

      <Card>
        <CardHeader icon="send" title="Send" subtitle="text, link or file" />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Type or paste — a link opens in the browser"
          placeholderTextColor={palette.muted}
          multiline
          style={{
            minHeight: 72,
            color: palette.light_foreground,
            fontFamily: font.regular,
            fontSize: size.body,
            backgroundColor: palette.darker_background,
            borderColor: palette.lighter_background,
            borderWidth: 1,
            borderRadius: radius.sm,
            padding: space.md,
            marginBottom: space.md,
            textAlignVertical: 'top',
          }}
        />
        <Button
          icon={/^https?:\/\/\S+$/i.test(draft.trim()) ? 'external-link' : 'clipboard'}
          label={/^https?:\/\/\S+$/i.test(draft.trim()) ? 'Open on desktop' : 'Copy on desktop'}
          onPress={sendText}
          variant="solid"
          loading={busy === 'text'}
          disabled={!connected || !draft.trim()}
        />
        <View style={{ flexDirection: 'row', gap: space.sm, marginTop: space.sm }}>
          <Button icon="file" label="File" onPress={pickDocument} loading={busy === 'file'} disabled={!connected} style={{ flex: 1 }} />
          <Button icon="image" label="Photo" onPress={pickPhoto} loading={busy === 'photo'} disabled={!connected} style={{ flex: 1 }} />
        </View>
      </Card>

      {offers.length ? (
        <Card>
          <CardHeader icon="download" title="Sent to you" subtitle="from the desktop" />
          {offers.map((offer, i) => (
            <View key={offer.token}>
              {i > 0 ? <Divider style={{ marginVertical: space.xs }} /> : null}
              <OfferRow
                offer={offer}
                uri={local[offer.token]}
                saved={!!saved[offer.token]}
                busy={busy}
                onOpen={() => openOffer(offer)}
                onSave={() => saveOffer(offer)}
                onShare={() => shareOffer(offer)}
              />
            </View>
          ))}
        </Card>
      ) : null}

      <Card>
        <CardHeader
          icon="inbox"
          title="Desktop inbox"
          subtitle="~/Downloads/Omarchy Connect"
          right={<Button icon="refresh-cw" variant="ghost" onPress={loadInbox} />}
        />
        {inbox.length ? (
          inbox.map((item, i) => (
            <View key={item.name}>
              {i > 0 ? <Divider style={{ marginVertical: space.xs }} /> : null}
              <ListRow title={item.name} subtitle={`${bytes(item.size)} · ${clock(item.at)}`} right={<Value tone={palette.muted}>↓</Value>} />
            </View>
          ))
        ) : (
          <Empty icon="inbox" text="Nothing received yet" />
        )}
      </Card>

      <Viewer
        offer={viewed}
        uri={viewed ? local[viewed.token] : undefined}
        saved={viewed ? !!saved[viewed.token] : false}
        saving={!!viewed && busy === `save:${viewed.token}`}
        sharing={!!viewed && busy === `share:${viewed.token}`}
        onSave={() => viewed && saveOffer(viewed)}
        onShare={() => viewed && shareOffer(viewed)}
        onClose={() => setViewing(null)}
      />
    </Screen>
  )
}

/**
 * One file the desktop is holding for you.
 *
 * A picture shows itself: the thumbnail is the file, not an icon standing in
 * for it, so you can tell the screenshot you wanted from the three before it
 * without opening any of them. Anything the gallery would not take keeps the
 * share sheet it always had.
 */
function OfferRow({
  offer,
  uri,
  saved,
  busy,
  onOpen,
  onSave,
  onShare,
}: {
  offer: Offer
  uri?: string
  saved: boolean
  busy: string | null
  onOpen: () => void
  onSave: () => void
  onShare: () => void
}) {
  const { palette } = useConnection()
  const kind = mediaKind(offer.name)
  const gallery = kind !== 'file'
  const settling = busy === `open:${offer.token}`

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: space.sm }}>
      <Pressable onPress={onOpen} style={{ width: THUMB, height: THUMB }}>
        {uri && kind === 'image' ? (
          <Image
            source={{ uri }}
            style={{
              width: THUMB,
              height: THUMB,
              borderRadius: radius.sm,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: palette.lighter_background,
            }}
          />
        ) : (
          <View
            style={{
              width: THUMB,
              height: THUMB,
              borderRadius: radius.sm,
              borderWidth: StyleSheet.hairlineWidth * 2,
              borderColor: palette.lighter_background,
              backgroundColor: palette.darker_background,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {settling ? (
              <ActivityIndicator size="small" color={palette.accent} />
            ) : (
              <Feather name={iconFor(kind)} size={18} color={palette.muted} />
            )}
          </View>
        )}
      </Pressable>

      <Pressable onPress={onOpen} style={{ flex: 1, marginHorizontal: space.md }}>
        <Text style={{ color: palette.light_foreground, fontFamily: font.regular, fontSize: size.body }} numberOfLines={1}>
          {offer.name}
        </Text>
        <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label, marginTop: 2 }} numberOfLines={1}>
          {bytes(offer.size)}
          {offer.at ? ` · ${clock(offer.at)}` : ''}
        </Text>
      </Pressable>

      {gallery ? (
        <Button
          icon={saved ? 'check' : 'download'}
          variant="ghost"
          tone={saved ? palette.green : undefined}
          loading={busy === `save:${offer.token}`}
          onPress={onSave}
        />
      ) : null}
      <Button icon="share-2" variant="ghost" loading={busy === `share:${offer.token}`} onPress={onShare} />
    </View>
  )
}

/** How far a pinch may go. Past this a desktop screenshot is only its own pixels. */
const MAX_ZOOM = 5

/** A drag shorter than this was somebody tapping, not somebody panning. */
const TAP_SLOP = 6

/**
 * Pinch to zoom, drag to move, tap to leave.
 *
 * Hand-rolled on the responder system for the same reason the level bars are:
 * this is the one screen in the app that wants a gesture, and `reanimated` plus
 * `gesture-handler` is a large pair of dependencies to carry for it. The
 * transform sits on a child that takes no touches, so the coordinates arriving
 * here are always the untransformed ones — the alternative is measuring a view
 * against itself after it has moved.
 *
 * A tap closes only while the picture is at rest. Zoomed in, it goes back to
 * whole first: a photo you leaned into is not a photo you meant to dismiss.
 */
function Zoomable({ uri, onTap }: { uri: string; onTap: () => void }) {
  const scale = useRef(new Animated.Value(1)).current
  const offsetX = useRef(new Animated.Value(0)).current
  const offsetY = useRef(new Animated.Value(0)).current
  const frame = useRef({ width: 0, height: 0 }).current

  /**
   * Where the gesture is now, and where it started. Kept in a ref rather than
   * state because a pinch redraws every frame and none of it belongs in React.
   */
  const g = useRef({
    scale: 1,
    x: 0,
    y: 0,
    fromScale: 1,
    fromX: 0,
    fromY: 0,
    spread: 1,
    focalX: 0,
    focalY: 0,
    startX: 0,
    startY: 0,
    pointers: 0,
    moved: false,
  }).current

  const apply = (next: number, x: number, y: number) => {
    g.scale = next
    g.x = x
    g.y = y
    scale.setValue(next)
    offsetX.setValue(x)
    offsetY.setValue(y)
  }

  /** Keep the picture from being dragged off its own screen. */
  const bound = (value: number, span: number, zoom: number) => {
    const limit = Math.max(0, (span * (zoom - 1)) / 2)
    return Math.max(-limit, Math.min(limit, value))
  }

  const spreadOf = (a: NativeTouch, b: NativeTouch) =>
    Math.max(1, Math.hypot(a.locationX - b.locationX, a.locationY - b.locationY))

  /** Re-read the starting point, either at the grant or as a finger joins or leaves. */
  const anchor = (touches: NativeTouch[]) => {
    g.pointers = touches.length
    g.fromScale = g.scale
    g.fromX = g.x
    g.fromY = g.y
    if (touches.length >= 2) {
      const [a, b] = touches
      g.spread = spreadOf(a, b)
      g.focalX = (a.locationX + b.locationX) / 2 - frame.width / 2
      g.focalY = (a.locationY + b.locationY) / 2 - frame.height / 2
    } else if (touches.length === 1) {
      g.startX = touches[0].locationX
      g.startY = touches[0].locationY
    }
  }

  const settle = () => {
    g.scale = 1
    g.x = 0
    g.y = 0
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 160, useNativeDriver: false }),
      Animated.timing(offsetX, { toValue: 0, duration: 160, useNativeDriver: false }),
      Animated.timing(offsetY, { toValue: 0, duration: 160, useNativeDriver: false }),
    ]).start()
  }

  const onMove = (event: GestureResponderEvent) => {
    const touches = event.nativeEvent.touches as unknown as NativeTouch[]
    // A finger landed or lifted mid-gesture: start again from where we are,
    // so the picture does not jump by the difference.
    if (touches.length !== g.pointers) {
      anchor(touches)
      return
    }
    if (touches.length >= 2) {
      const [a, b] = touches
      const next = Math.max(1, Math.min(MAX_ZOOM, (g.fromScale * spreadOf(a, b)) / g.spread))
      // Hold the point between the fingers still while everything around it grows.
      const ratio = next / g.fromScale
      const x = g.focalX - (g.focalX - g.fromX) * ratio
      const y = g.focalY - (g.focalY - g.fromY) * ratio
      g.moved = true
      apply(next, bound(x, frame.width, next), bound(y, frame.height, next))
      return
    }
    if (touches.length === 1) {
      const dx = touches[0].locationX - g.startX
      const dy = touches[0].locationY - g.startY
      if (Math.hypot(dx, dy) > TAP_SLOP) g.moved = true
      if (g.scale <= 1) return
      apply(g.scale, bound(g.fromX + dx, frame.width, g.scale), bound(g.fromY + dy, frame.height, g.scale))
    }
  }

  const onRelease = () => {
    const tapped = !g.moved
    g.pointers = 0
    if (!tapped) return
    if (g.scale > 1) settle()
    else onTap()
  }

  return (
    <View
      style={{ flex: 1 }}
      onLayout={(event) => {
        frame.width = event.nativeEvent.layout.width
        frame.height = event.nativeEvent.layout.height
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(event) => {
        g.moved = false
        anchor(event.nativeEvent.touches as unknown as NativeTouch[])
      }}
      onResponderMove={onMove}
      onResponderRelease={onRelease}
      onResponderTerminate={onRelease}
    >
      <Animated.View
        pointerEvents="none"
        style={{ flex: 1, transform: [{ translateX: offsetX }, { translateY: offsetY }, { scale }] }}
      >
        <Image source={{ uri }} style={{ flex: 1 }} resizeMode="contain" />
      </Animated.View>
    </View>
  )
}

/**
 * The picture at the size it was sent at. Full screen, because a photo pushed
 * from the desktop is usually the whole point of the message, and a 52-pixel
 * square is not an answer to "what did you send me" — and pinchable, because
 * half of what a desktop sends is a screenshot with text on it.
 */
function Viewer({
  offer,
  uri,
  saved,
  saving,
  sharing,
  onSave,
  onShare,
  onClose,
}: {
  offer: Offer | null
  uri?: string
  saved: boolean
  saving: boolean
  sharing: boolean
  onSave: () => void
  onShare: () => void
  onClose: () => void
}) {
  const { palette } = useConnection()
  const insets = useSafeAreaInsets()
  const open = !!offer && !!uri

  return (
    <Modal visible={open} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: palette.background }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingTop: insets.top + space.md,
            paddingHorizontal: space.lg,
            paddingBottom: space.md,
          }}
        >
          <View style={{ flex: 1, marginRight: space.md }}>
            <Text
              style={{ color: palette.bright_foreground, fontFamily: font.medium, fontSize: size.body }}
              numberOfLines={1}
            >
              {offer?.name}
            </Text>
            <Text style={{ color: palette.muted, fontFamily: font.regular, fontSize: size.label, marginTop: 2 }}>
              {bytes(offer?.size)}
            </Text>
          </View>
          <Button icon="x" variant="ghost" onPress={onClose} />
        </View>

        <View style={{ flex: 1, overflow: 'hidden', backgroundColor: alpha(palette.darker_background, 0.6) }}>
          {uri ? <Zoomable key={uri} uri={uri} onTap={onClose} /> : null}
        </View>

        <View
          style={{
            flexDirection: 'row',
            gap: space.sm,
            paddingHorizontal: space.lg,
            paddingTop: space.md,
            paddingBottom: insets.bottom + space.lg,
          }}
        >
          <Button
            icon={saved ? 'check' : 'download'}
            label={saved ? 'In your gallery' : 'Save to gallery'}
            variant="solid"
            tone={saved ? palette.green : undefined}
            loading={saving}
            onPress={onSave}
            style={{ flex: 1 }}
          />
          <Button icon="share-2" label="Share" loading={sharing} onPress={onShare} style={{ flex: 1 }} />
        </View>
      </View>
    </Modal>
  )
}
