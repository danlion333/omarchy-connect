import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Animated,
  Image,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from 'react-native'
import { Feather } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as Sharing from 'expo-sharing'

import { useConnection, usePalette } from '../state/ConnectionContext'
import {
  Button,
  Buttons,
  Caps,
  Card,
  CardHeader,
  Code,
  Divider,
  Empty,
  Field,
  Hint,
  IconButton,
  Label,
  Meter,
  Mono,
  Notice,
  Pill,
  Screen,
  ScreenHeader,
  Section,
  Title,
  useConfirm,
  useSurface,
  useToast,
  type IconName,
} from '../ui/kit'
import { bytes, clock } from '../lib/format'
import { copyPicture } from '../lib/copyimage'
import { downloadOffer } from '../lib/download'
import { uploadFile } from '../lib/transfer'
import { saveToGallery } from '../lib/gallery'
import { iconFor, mediaKind, type MediaKind } from '../lib/media'
import {
  describeShare,
  deliverShare,
  isLink,
  shareBlocked,
  shareSummary,
  type SharePayload,
} from '../lib/share'
import { copyPictureToClipboard } from '../../modules/omarchy-link'
import { alpha, font, line, radius, size, space, touch } from '../theme'

type InboxItem = { name: string; size: number; at: number }
type StandingOffer = { token: string; name: string; size: number; expiresAt: number }
type Offer = { token: string; name: string; size: number; at?: number }

/** One finger, as the responder system hands it over. */
type NativeTouch = { locationX: number; locationY: number }

/**
 * Which card a failure belongs to. A failure is drawn where the thing that
 * failed is, not at the top of the screen, so every error carries the card it
 * came from. What *worked* is a toast instead — the screen says so once, over
 * the bar, and the card keeps its shape.
 */
type Where = 'incoming' | 'clipboard' | 'inbox'

/** Whatever was thrown, untouched — `Notice` is what makes it readable. */
type Failure = { where: Where; error: unknown; retry?: () => void }

/**
 * How large a picture may be before the phone stops fetching it on sight.
 * A preview costs the whole file — there is no thumbnail endpoint — so above
 * this the thumbnail waits for a tap rather than eating a scan of the LAN.
 */
const PREVIEW_MAX = 24 * 1024 * 1024

const THUMB = 52

/** How many older clips are shown before the history asks to be unfolded. */
const HISTORY_FOLD = 3

/** How many lines of the desktop's clip the card shows before it is folded. */
const CLIP_LINES = 6

/** Where the desktop drops what it is sent, when it has not said otherwise. */
const DEFAULT_INBOX = '~/Downloads/Omarchy Connect'

/** One line of a copied thing: whitespace flattened, then cut to fit a row. */
const preview = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat || '(blank)'
}

/** `/home/dan/Downloads/…` is a header that does not fit; `~/Downloads/…` does. */
const homely = (path: string) => path.replace(/^\/home\/[^/]+/, '~').replace(/^\/root/, '~')

/**
 * When a file landed, in the words a file list uses: the time today, the day
 * yesterday, the date before that. `clock()` is the same idea for a value on
 * a row; this one is for a subtitle that has to read as a sentence.
 */
const when = (at: number | null | undefined) => {
  if (!at) return 'some time ago'
  const day = new Date(at)
  const now = new Date()
  if (day.toDateString() === now.toDateString()) return clock(at)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (day.toDateString() === yesterday.toDateString()) return 'yesterday'
  return clock(at)
}

const TEXTY = new Set([
  'txt', 'md', 'log', 'json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'csv', 'sh', 'lua', 'js', 'ts',
  'tsx', 'jsx', 'py', 'rs', 'go', 'c', 'h', 'cpp', 'css', 'diff', 'patch', 'pdf',
])

/** The glyph that stands for a file in a list, going by its name. */
function rowIcon(name: string): IconName {
  const kind = mediaKind(name)
  if (kind !== 'file') return iconFor(kind) as IconName
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  if (ext === 'html' || ext === 'htm' || ext === 'url') return 'globe'
  if (TEXTY.has(ext)) return 'file-text'
  return 'file'
}

/**
 * `incoming` is a share another app handed over through the system share
 * sheet. It is taken once — `onIncomingTaken` says so — and then held here
 * until there is a desktop answering, because a cold start from a share is
 * always a second or two ahead of the socket.
 */
export function ShareScreen({
  incoming,
  onIncomingTaken,
}: { incoming?: SharePayload | null; onIncomingTaken?: () => void } = {}) {
  const { call, can, client, clipboard, files, hello, palette, status } = useConnection()
  const toast = useToast()
  const confirm = useConfirm()
  const [draft, setDraft] = useState('')
  const [inbox, setInbox] = useState<InboxItem[]>([])
  /** True once the desktop's folder has answered at least once. */
  const [inboxLoaded, setInboxLoaded] = useState(false)
  /** Why the folder listing is not to be trusted, when the last ask failed. */
  const [inboxError, setInboxError] = useState<unknown>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [standing, setStanding] = useState<StandingOffer[]>([])
  const [local, setLocal] = useState<Record<string, string>>({})
  const [saved, setSaved] = useState<Record<string, true>>({})
  const [viewing, setViewing] = useState<string | null>(null)
  const [error, setError] = useState<Failure | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  /** The history entry last tapped, so its row can say so. */
  const [copied, setCopied] = useState<string | null>(null)
  /** A share from another app, waiting for a desktop that will take it. */
  const [queued, setQueued] = useState<SharePayload | null>(null)
  /** Whether the clipboard history is unfolded past its first few rows. */
  const [allHistory, setAllHistory] = useState(false)
  /**
   * What is going up right now. A picked file is one row with a spinner; a
   * multi-file share is the same row with a real fraction under it, counted as
   * each upload comes back — the uploader reports nothing finer than "done",
   * so the meter counts files and never invents bytes.
   */
  const [sending, setSending] = useState<{ label: string; done: number; total: number } | null>(null)

  const connected = status === 'connected'
  /**
   * Whether the desktop can hold a clipboard at all. `wl-copy` is not on every
   * machine, and a card that offers to paste onto a desktop that cannot paste
   * is a lie — so it is drawn dimmed with the reason instead. Only once the
   * desktop has actually said hello: before that, "offline" is the reason.
   */
  const clips = !connected || can('share', 'clipboard')

  /** The folder on the desktop, as the desktop named it when it said hello. */
  const inboxPath = useMemo(() => {
    const named = (hello?.capabilities as any)?.share?.inbox
    return typeof named === 'string' && named ? homely(named) : DEFAULT_INBOX
  }, [hello])

  const fail = (where: Where, err: unknown, retry?: () => void) => {
    setError({ where, error: err, retry })
  }

  const loadInbox = useCallback(async () => {
    if (!connected) return
    setRefreshing(true)
    try {
      const res = await call<{ items: InboxItem[] }>('share.inbox', { limit: 15 })
      setInbox(res.items)
      setInboxLoaded(true)
      setInboxError(null)
    } catch (err) {
      // The inbox is a nicety, not a requirement: the rest of the screen
      // carries on, and the card says why its list is stale.
      setInboxError(err)
    } finally {
      setRefreshing(false)
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

  const reload = useCallback(() => {
    void loadInbox()
    void loadOffers()
  }, [loadInbox, loadOffers])

  useEffect(() => {
    loadInbox()
  }, [loadInbox, files.length])

  useEffect(() => {
    loadOffers()
  }, [loadOffers, files.length])

  /* ── clipboard ─────────────────────────────────────────────────────── */

  const pushClipboard = useCallback(async () => {
    setBusy('push')
    try {
      const text = await Clipboard.getStringAsync()
      if (!text) {
        toast({ value: 'nothing to send', hint: 'the phone clipboard is empty', icon: 'clipboard' })
        return
      }
      await call('clipboard.set', { text })
      toast({ value: 'wl-copy', hint: 'the desktop clipboard is yours now' })
    } catch (err) {
      fail('clipboard', err, () => {
        void pushClipboard()
      })
    } finally {
      setBusy(null)
    }
  }, [call, toast])

  /**
   * Copies one remembered entry back onto the phone.
   *
   * The history is only worth keeping if reaching into it is one tap, so this
   * is deliberately not the `clipboard.get` round trip below: the text is
   * already here, and an entry from ten minutes ago is not what the desktop
   * would answer with anyway. The tick beside the row it copied is the
   * confirmation, and it survives long enough to be read.
   */
  const copyEntry = useCallback(
    async (text: string) => {
      try {
        await Clipboard.setStringAsync(text)
        setCopied(text)
        toast({ value: 'copied on phone', hint: preview(text), icon: 'smartphone' })
      } catch (err) {
        fail('clipboard', err)
      }
    },
    [toast],
  )

  const pullClipboard = useCallback(async () => {
    setBusy('pull')
    try {
      const res = await call<{ text: string | null; kind: string; token?: string | null }>('clipboard.get')
      if (res.kind !== 'text' || !res.text) {
        // A picture does not come back as text, but it is already the clip
        // above — the event that announced it carries the same offer this
        // answer does, and tapping that row pastes it.
        toast({
          value: 'wl-paste',
          hint: res.kind === 'binary' ? 'a picture — tap it to copy it' : 'the desktop clipboard holds no text',
          icon: 'clipboard',
        })
        return
      }
      await Clipboard.setStringAsync(res.text)
      setCopied(res.text)
      toast({ value: 'wl-paste', hint: 'copied on this phone', icon: 'smartphone' })
    } catch (err) {
      fail('clipboard', err, () => {
        void pullClipboard()
      })
    } finally {
      setBusy(null)
    }
  }, [call, toast])

  /** A link the desktop copied, opened in this phone's own browser. */
  const openHere = useCallback(
    async (url: string) => {
      try {
        await Linking.openURL(url)
        toast({ value: 'open here', hint: preview(url), icon: 'external-link' })
      } catch (err) {
        fail('clipboard', err)
      }
    },
    [toast],
  )

  /* ── text ──────────────────────────────────────────────────────────── */

  const sendText = useCallback(async () => {
    const text = draft.trim()
    if (!text) return
    setBusy('text')
    try {
      if (isLink(text)) {
        await call('system.openUrl', { url: text })
        toast({ value: 'xdg-open', hint: 'opened on the desktop', icon: 'external-link' })
      } else {
        await call('share.text', { text, action: 'clipboard' })
        toast({ value: 'wl-copy', hint: 'the desktop clipboard is yours now' })
      }
      setDraft('')
    } catch (err) {
      fail('clipboard', err)
    } finally {
      setBusy(null)
    }
  }, [call, draft, toast])

  /* ── files out ─────────────────────────────────────────────────────── */

  const upload = useCallback(
    async (uri: string, name: string) => {
      if (!client) throw new Error('not connected')
      const result = await uploadFile(`${client.baseUrl}/api/upload`, uri, await client.uploadPass(name))
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
      setSending({ label: asset.name, done: 0, total: 1 })
      await upload(asset.uri, asset.name)
      toast({ value: 'omarchy-connect send', hint: `${asset.name} landed in the inbox`, icon: 'upload' })
      loadInbox()
    } catch (err) {
      fail('inbox', err)
    } finally {
      setSending(null)
      setBusy(null)
    }
  }, [loadInbox, toast, upload])

  const pickPhoto = useCallback(async () => {
    setBusy('photo')
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync()
      if (!permission.granted) {
        toast({ value: 'no photos', hint: 'Android denied access to the library', icon: 'image' })
        return
      }
      const picked = await ImagePicker.launchImageLibraryAsync({ quality: 1 })
      if (picked.canceled) return
      const asset = picked.assets[0]
      const name = asset.fileName || `photo-${Date.now()}.jpg`
      setSending({ label: name, done: 0, total: 1 })
      await upload(asset.uri, name)
      toast({ value: 'omarchy-connect send', hint: `${name} landed in the inbox`, icon: 'upload' })
      loadInbox()
    } catch (err) {
      fail('inbox', err)
    } finally {
      setSending(null)
      setBusy(null)
    }
  }, [loadInbox, toast, upload])

  /* ── the system share sheet ────────────────────────────────────────── */

  /**
   * Send a share on, and say what became of it.
   *
   * Cleared from the queue first, on purpose: the outcome — including a file
   * that would not upload — is reported rather than retried forever, and the
   * one thing that must never happen is the same photo going twice because a
   * re-render found it still waiting. The outcome lands on the Inbox card,
   * because the card that held the share is gone by the time there is one.
   */
  const deliver = useCallback(
    async (payload: SharePayload) => {
      setQueued(null)
      setBusy('incoming')
      const total = payload.files.length + ((payload.text || '').trim() ? 1 : 0)
      let done = 0
      setSending({ label: describeShare(payload), done, total })
      try {
        const step = () => {
          done += 1
          setSending({ label: describeShare(payload), done, total })
        }
        const outcome = await deliverShare(payload, {
          openUrl: (url) => call('system.openUrl', { url }),
          copyText: async (text) => {
            const answer = await call('share.text', { text, action: 'clipboard' })
            step()
            return answer
          },
          upload: async (item) => {
            const answer = await upload(item.uri, item.name)
            step()
            return answer
          },
        })
        if (outcome.failed.length) fail('inbox', shareSummary(outcome))
        else toast({ value: 'omarchy-connect send', hint: shareSummary(outcome), icon: 'share-2' })
        loadInbox()
      } catch (err) {
        fail('inbox', err)
      } finally {
        setSending(null)
        setBusy(null)
      }
    },
    [call, loadInbox, toast, upload],
  )

  /** Throwing a share away is the one thing here that cannot be undone. */
  const discard = useCallback(async () => {
    if (!queued) return
    const ok = await confirm({
      title: 'Discard the share?',
      detail: describeShare(queued),
      confirmLabel: 'Discard',
    })
    if (ok) setQueued(null)
  }, [confirm, queued])

  // Taken from the tree above as soon as it appears, so that a second render
  // does not see the same share again.
  useEffect(() => {
    if (!incoming) return
    setQueued(incoming)
    onIncomingTaken?.()
  }, [incoming, onIncomingTaken])

  // Held until the socket is up. A share that arrived with the app cold is
  // ahead of the link by a second or two, and refusing it in that second
  // would be refusing nearly every share.
  useEffect(() => {
    if (queued && connected) deliver(queued)
  }, [connected, deliver, queued])

  /* ── files in ──────────────────────────────────────────────────────── */

  /**
   * The offers worth showing: whatever arrived live, newest first, then the
   * ones the daemon was still holding when we asked. A token appears once.
   */
  const offers = useMemo<Offer[]>(() => {
    const seen = new Map<string, Offer>()
    // A picture copied on the desktop is an offer like any other — the daemon
    // spools the bytes and registers them in the same table — so it belongs in
    // the same card, where it gets the same thumbnail, the same Save and the
    // same viewer instead of a second half-built version of all three.
    for (const entry of clipboard) {
      if (entry.token && entry.name && !seen.has(entry.token)) {
        seen.set(entry.token, { token: entry.token, name: entry.name, size: entry.size ?? 0, at: entry.at })
      }
    }
    for (const file of files) {
      if (file.direction === 'out' && file.token && !seen.has(file.token)) {
        seen.set(file.token, { token: file.token, name: file.name, size: file.size, at: file.at })
      }
    }
    for (const offer of [...standing].sort((a, b) => b.expiresAt - a.expiresAt)) {
      if (!seen.has(offer.token)) seen.set(offer.token, { token: offer.token, name: offer.name, size: offer.size })
    }
    return [...seen.values()]
  }, [clipboard, files, standing])

  /**
   * Which files in the desktop's folder this phone put there. `in` is into the
   * desktop, so those are the ones that went up from here — the row says
   * "from this phone" rather than claiming the desktop sent them.
   */
  const mine = useMemo(() => {
    const names = new Set<string>()
    for (const file of files) if (file.direction === 'in') names.add(file.name)
    return names
  }, [files])

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
        const uri = await downloadOffer(client.downloadUrl(token), token, name, await client.downloadPass())
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
        toast({ value: offer.name, hint: 'saved in your gallery', icon: 'download' })
      } catch (err) {
        fail('inbox', err, () => {
          void saveOffer(offer)
        })
      } finally {
        setBusy(null)
      }
    },
    [fetchOffer, toast],
  )

  /**
   * A picture the desktop copied, onto this phone's clipboard.
   *
   * The row used to open the picture, because there was no way to paste one —
   * and the note on `pullClipboard` said as much. There is one now: the bytes
   * go to a provider URI the pasting app is allowed to read (`ImageClip`), so
   * a screenshot taken on the desktop is one tap from a chat here. The fetch
   * is the shared one, so a preview already on the disk is not downloaded
   * again for it.
   */
  const copyEntryPicture = useCallback(
    async (picture: { token: string; name: string }) => {
      setBusy(`copy:${picture.token}`)
      try {
        const said = await copyPicture(picture, { fetch: fetchOffer, copy: copyPictureToClipboard })
        toast({ value: 'copied on phone', hint: said, icon: 'smartphone' })
        setCopied(picture.token)
      } catch (err) {
        fail('clipboard', err, () => {
          void copyEntryPicture(picture)
        })
      } finally {
        setBusy(null)
      }
    },
    [fetchOffer, toast],
  )

  const shareOffer = useCallback(
    async (offer: Offer) => {
      setBusy(`share:${offer.token}`)
      try {
        const uri = await fetchOffer(offer.token, offer.name)
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri)
        else toast({ value: offer.name, hint: `saved to ${uri}`, icon: 'download' })
      } catch (err) {
        fail('inbox', err, () => {
          void shareOffer(offer)
        })
      } finally {
        setBusy(null)
      }
    },
    [fetchOffer, toast],
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
          fail('inbox', err, () => {
            void openOffer(offer)
          })
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

  /** What a card says about itself when the last thing it was asked for failed. */
  const notice = (where: Where) => (
    <Notice
      error={error?.where === where ? error.error : null}
      onDismiss={() => setError(null)}
      action={error?.where === where && error.retry ? { label: 'Try again', icon: 'refresh-cw', onPress: error.retry } : null}
    />
  )

  const latest = clipboard[0] ?? null
  const latestText = latest && typeof latest.text === 'string' ? latest.text : null
  const latestPicture = latest && !latestText && latest.token ? { token: latest.token, name: latest.name || 'clipboard' } : null
  const earlier = clipboard.slice(1)
  const shownEarlier = allHistory ? earlier : earlier.slice(0, HISTORY_FOLD)

  const blocked = shareBlocked({ paired: true, connected })
  const inboxEmpty = !offers.length && !inbox.length
  const inboxCount = inbox.length === 1 ? '1 file' : `${inbox.length} files`

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={inboxLoaded && refreshing} onRefresh={reload} enabled={connected} tintColor={palette.accent} colors={[palette.accent]} />
      }
    >
      <ScreenHeader
        title="Share"
        sub={inboxPath}
        right={
          <IconButton icon="refresh-cw" label="Refresh" onPress={reload} loading={refreshing} disabled={!connected} />
        }
      />

      {queued ? (
        <Card tone={palette.accent}>
          <CardHeader
            icon="share-2"
            title="Incoming"
            tone={palette.accent}
            subtitle={describeShare(queued)}
            right={<Pill label="shared" tone={palette.accent} icon="share-2" />}
          />
          {queued.files.map((file, i) => {
            const kind = mediaKind(file.name)
            const isLast = i === queued.files.length - 1 && !(queued.text || '').trim()
            return (
              <FileRow
                key={`${file.uri}-${i}`}
                title={file.name}
                subtitle={file.size ? bytes(file.size) : null}
                left={<Thumb uri={kind === 'image' ? file.uri : undefined} kind={kind} />}
                last={isLast}
              />
            )
          })}
          {(queued.text || '').trim() ? (
            <>
              <Code lines={3}>{(queued.text as string).trim()}</Code>
              <Label style={{ color: palette.muted }}>{isLink(queued.text as string) ? 'a link' : 'some text'}</Label>
            </>
          ) : null}
          {queued.dropped ? (
            <Hint icon="alert-triangle" tone={palette.orange}>
              {queued.dropped === 1 ? 'One attachment could not be read' : `${queued.dropped} attachments could not be read`}
            </Hint>
          ) : null}
          <Notice error={blocked} tone="warning" />
          <Buttons>
            <Button
              icon="send"
              label="Send"
              variant="primary"
              onPress={() => deliver(queued)}
              loading={busy === 'incoming'}
              disabled={!connected}
            />
            <Button icon="x" label="Discard" onPress={discard} />
          </Buttons>
        </Card>
      ) : null}

      <Card dim={!clips}>
        <CardHeader
          icon="clipboard"
          title="Clipboard"
          tone={connected && clips ? undefined : palette.muted}
          subtitle={
            !connected
              ? 'desktop offline'
              : !clips
                ? 'no clipboard on the desktop'
                : latest
                  ? `on the desktop · ${clock(latest.at)}`
                  : 'nothing copied yet'
          }
          // The mock's header carries nothing on the right; the app's clipboard
          // is two-way, and asking for the desktop's clip and handing it this
          // phone's are the two commands with nowhere else to live.
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <IconButton
                icon="download"
                label="Read the desktop clipboard"
                onPress={pullClipboard}
                loading={busy === 'pull'}
                disabled={!connected || !clips}
              />
              <IconButton
                icon="upload"
                label="Send the phone clipboard"
                onPress={pushClipboard}
                loading={busy === 'push'}
                disabled={!connected || !clips}
              />
            </View>
          }
        />
        {notice('clipboard')}

        {latestText !== null ? (
          <>
            <Pressable
              onPress={() => copyEntry(latestText)}
              accessibilityRole="button"
              accessibilityLabel="Copy to phone"
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <Code lines={CLIP_LINES}>{latestText.trim() || '(blank)'}</Code>
            </Pressable>
            <Buttons>
              <Button
                compact
                icon={copied === latestText ? 'check' : 'smartphone'}
                tone={copied === latestText ? palette.green : undefined}
                label="Copy on phone"
                onPress={() => copyEntry(latestText)}
              />
              {isLink(latestText) ? (
                <Button compact icon="external-link" label="Open here" onPress={() => openHere(latestText.trim())} />
              ) : null}
            </Buttons>
          </>
        ) : latest ? (
          // A copied picture, and the same tap as a text clip: the row puts the
          // picture itself in the phone's paste buffer. Looking at it is the
          // thumbnail in the inbox below, which is holding this very offer.
          <>
            <FileRow
              title={latest.name || latest.mime || 'image'}
              subtitle={`${clock(latest.at)}${latest.size ? ` · ${bytes(latest.size)}` : ''}`}
              left={<Thumb uri={latest.token ? local[latest.token] : undefined} kind="image" />}
              onPress={() => latestPicture && copyEntryPicture(latestPicture)}
              last
            />
            <Buttons>
              <Button
                compact
                icon={copied === latest.token ? 'check' : 'smartphone'}
                tone={copied === latest.token ? palette.green : undefined}
                label="Copy on phone"
                loading={busy === `copy:${latest.token}`}
                onPress={() => latestPicture && copyEntryPicture(latestPicture)}
              />
            </Buttons>
          </>
        ) : (
          <Empty icon="clipboard" text="Nothing copied yet" />
        )}

        <Divider />
        <Field
          icon="arrow-up"
          value={draft}
          onChange={setDraft}
          placeholder="Send text to the desktop clipboard"
          onSubmit={sendText}
          right={
            <IconButton
              icon="send"
              label={isLink(draft) ? 'Open on the desktop' : 'Copy on the desktop'}
              onPress={sendText}
              loading={busy === 'text'}
              disabled={!connected || !clips || !draft.trim()}
            />
          }
        />

        {earlier.length ? (
          <>
            <Divider />
            <Section
              title="Earlier"
              right={
                earlier.length > HISTORY_FOLD ? (
                  <Button
                    label={allHistory ? 'Fewer' : `All ${earlier.length}`}
                    variant="ghost"
                    compact
                    onPress={() => setAllHistory((was) => !was)}
                  />
                ) : (
                  <Caps>{earlier.length}</Caps>
                )
              }
            />
            {shownEarlier.map((entry, i) => {
              const isLast = i === shownEarlier.length - 1
              if (typeof entry.text === 'string') {
                const text = entry.text
                return (
                  <FileRow
                    key={`${text}-${entry.at}-${i}`}
                    title={preview(text)}
                    subtitle={clock(entry.at)}
                    onPress={() => copyEntry(text)}
                    right={
                      <IconButton
                        icon={copied === text ? 'check' : 'copy'}
                        tone={copied === text ? palette.green : undefined}
                        label="Copy to phone"
                        onPress={() => copyEntry(text)}
                      />
                    }
                    last={isLast}
                  />
                )
              }
              const picture = entry.token ? { token: entry.token, name: entry.name || 'clipboard' } : null
              return (
                <FileRow
                  key={`${entry.token}-${entry.at}-${i}`}
                  title={entry.name || entry.mime || 'image'}
                  subtitle={`${clock(entry.at)}${entry.size ? ` · ${bytes(entry.size)}` : ''}`}
                  left={<Thumb uri={entry.token ? local[entry.token] : undefined} kind="image" size={36} />}
                  onPress={() => (picture ? copyEntryPicture(picture) : undefined)}
                  right={
                    <IconButton
                      icon={copied === entry.token ? 'check' : 'copy'}
                      tone={copied === entry.token ? palette.green : undefined}
                      loading={busy === `copy:${entry.token}`}
                      label="Copy to phone"
                      onPress={() => (picture ? copyEntryPicture(picture) : undefined)}
                    />
                  }
                  last={isLast}
                />
              )
            })}
          </>
        ) : null}

        {!connected ? (
          <Hint icon="wifi-off">Needs the desktop online</Hint>
        ) : !clips ? (
          <Hint icon="alert-triangle">Needs wl-clipboard on the desktop</Hint>
        ) : null}
      </Card>

      <Card>
        <CardHeader
          title="Inbox"
          tone={!connected && inboxEmpty ? palette.muted : undefined}
          subtitle={
            !connected
              ? 'desktop offline'
              : offers.length
                ? `${offers.length} new · ${inboxCount}`
                : inboxLoaded
                  ? inboxCount
                  : 'loading…'
          }
          right={
            <IconButton
              icon="paperclip"
              label="Send a file"
              onPress={pickDocument}
              loading={busy === 'file'}
              disabled={!connected}
            />
          }
        />
        {notice('inbox')}
        <Notice
          error={inboxError}
          tone="warning"
          action={{ label: 'Try again', icon: 'refresh-cw', onPress: () => void loadInbox() }}
        />

        {/* The paperclip is the file picker; the phone's own photos are a
            different picker and the mock has no second button for them. */}
        <Buttons>
          <Button compact variant="ghost" icon="file" label="File" onPress={pickDocument} loading={busy === 'file'} disabled={!connected} />
          <Button compact variant="ghost" icon="image" label="Photo" onPress={pickPhoto} loading={busy === 'photo'} disabled={!connected} />
        </Buttons>

        {sending ? (
          <View style={{ gap: space.sm }}>
            <FileRow title={sending.label} subtitle={`sending · ${sending.done} of ${sending.total}`} icon="upload" last />
            {sending.total > 1 ? <Meter fraction={sending.done / sending.total} /> : <ActivityIndicator size="small" color={palette.accent} />}
          </View>
        ) : null}

        {offers.length ? (
          <>
            <Section title="Sent to you" right={<Caps>{offers.length}</Caps>} />
            {offers.map((offer, i) => (
              <OfferRow
                key={offer.token}
                offer={offer}
                uri={local[offer.token]}
                saved={!!saved[offer.token]}
                busy={busy}
                onOpen={() => openOffer(offer)}
                onSave={() => saveOffer(offer)}
                onShare={() => shareOffer(offer)}
                last={i === offers.length - 1}
              />
            ))}
          </>
        ) : null}

        {offers.length && inbox.length ? <Divider /> : null}

        {inbox.length ? (
          <>
            <Section title="On the desktop" right={<Caps>{inboxCount}</Caps>} />
            {inbox.map((item, i) => (
              <FileRow
                key={item.name}
                icon={rowIcon(item.name)}
                title={item.name}
                subtitle={`${mine.has(item.name) ? 'from this phone' : 'from the desktop'} · ${when(item.at)}`}
                right={<Label style={{ color: palette.muted }}>{bytes(item.size)}</Label>}
                last={i === inbox.length - 1}
              />
            ))}
          </>
        ) : null}

        {inboxEmpty && !sending ? (
          !connected ? (
            <Hint icon="wifi-off">Needs the desktop online</Hint>
          ) : !inboxLoaded && inboxError == null ? (
            <View style={{ alignItems: 'center', paddingVertical: space.xl }}>
              <ActivityIndicator color={palette.accent} />
            </View>
          ) : (
            <Empty
              icon="inbox"
              text="No files yet · Send one from the desktop with omarchy-connect send"
              action={{ label: 'Send a file', icon: 'paperclip', onPress: pickDocument }}
            />
          )
        ) : null}
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
 * without opening any of them. The row's one button is the thing most worth
 * doing with the file: into the gallery for anything the gallery would take,
 * the share sheet for everything else. Tapping the row itself opens a picture
 * and shares anything else, so nothing is more than a tap away.
 */
function OfferRow({
  offer,
  uri,
  saved,
  busy,
  onOpen,
  onSave,
  onShare,
  last,
}: {
  offer: Offer
  uri?: string
  saved: boolean
  busy: string | null
  onOpen: () => void
  onSave: () => void
  onShare: () => void
  last?: boolean
}) {
  const palette = usePalette()
  const kind = mediaKind(offer.name)
  const gallery = kind !== 'file'

  return (
    <FileRow
      title={offer.name}
      subtitle={`from the desktop · ${when(offer.at)}`}
      left={<Thumb uri={kind === 'image' ? uri : undefined} kind={kind} busy={busy === `open:${offer.token}`} />}
      onPress={onOpen}
      right={
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Label style={{ color: palette.muted }}>{bytes(offer.size)}</Label>
          {gallery ? (
            <IconButton
              icon={saved ? 'check' : 'download'}
              tone={saved ? palette.green : undefined}
              loading={busy === `save:${offer.token}`}
              label={saved ? 'In your gallery' : 'Save to gallery'}
              onPress={onSave}
            />
          ) : (
            <IconButton icon="share-2" loading={busy === `share:${offer.token}`} label="Share" onPress={onShare} />
          )}
        </View>
      }
      last={last}
    />
  )
}

/* ── local primitives ────────────────────────────────────────────────── */

/**
 * A `ListRow` whose title may take two lines.
 *
 * A filename is the value on this screen, and a desktop screenshot's name —
 * `Screenshot_2026-09-05_15-27-01.png` — is thirty-four characters beside a
 * thumbnail and a button, where one line holds twenty-two. Two lines hold
 * it; a name longer still is cut in the middle so the extension survives,
 * because ".png" is the half that says what the thing is. Otherwise drawn
 * exactly as the kit's row is — same 48, same hairline, same bleed under the
 * thumb. Belongs in the kit as an option on `ListRow`.
 */
function FileRow({
  title,
  subtitle,
  icon,
  left,
  right,
  onPress,
  last,
}: {
  title: string
  subtitle?: string | null
  icon?: IconName
  left?: React.ReactNode
  right?: React.ReactNode
  onPress?: () => void
  last?: boolean
}) {
  const p = usePalette()
  const { edge } = useSurface()
  const bleed = space.lg - 2
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? 'button' : undefined}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        minHeight: 48,
        paddingVertical: space.xs,
        marginHorizontal: onPress ? -bleed : 0,
        paddingHorizontal: onPress ? bleed : 0,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth * 2,
        borderBottomColor: edge,
        backgroundColor: pressed && onPress ? alpha(p.selection, 0.7) : 'transparent',
      })}
    >
      {icon ? <Feather name={icon} size={20} color={p.light_foreground} /> : null}
      {left}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Mono
          style={{ color: p.bright_foreground, fontFamily: font.regular, fontSize: size.value, lineHeight: line.value }}
          numberOfLines={2}
          ellipsizeMode="middle"
        >
          {title}
        </Mono>
        {subtitle ? (
          <Mono
            style={{ color: p.light_foreground, fontFamily: font.regular, fontSize: size.label, lineHeight: line.label }}
            numberOfLines={1}
          >
            {subtitle}
          </Mono>
        ) : null}
      </View>
      {right}
    </Pressable>
  )
}

/**
 * The square at the left of a file row: the picture itself when its bytes
 * are here, the kind's icon until then, a spinner while they are on the way.
 */
function Thumb({ uri, kind, busy, size: box = THUMB }: { uri?: string; kind: MediaKind; busy?: boolean; size?: number }) {
  const p = usePalette()
  const frame = {
    width: box,
    height: box,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: p.lighter_background,
  }
  if (uri && kind === 'image') return <Image source={{ uri }} style={frame} />
  return (
    <View style={[frame, { backgroundColor: p.darker_background, alignItems: 'center', justifyContent: 'center' }]}>
      {busy ? <ActivityIndicator size="small" color={p.accent} /> : <Feather name={iconFor(kind)} size={Math.round(box / 3)} color={p.muted} />}
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
 *
 * Everything the viewer can do sits in one bar at the top — close, save,
 * share — so the picture has the rest of the screen to itself.
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
  const palette = usePalette()
  const insets = useSafeAreaInsets()
  const open = !!offer && !!uri

  return (
    <Modal visible={open} animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: palette.background }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            paddingTop: insets.top + space.sm,
            paddingHorizontal: space.lg,
            paddingBottom: space.sm,
            minHeight: touch,
          }}
        >
          <IconButton icon="x" label="Close" onPress={onClose} />
          <View style={{ flex: 1, minWidth: 0, marginHorizontal: space.xs }}>
            <Title numberOfLines={2}>{offer?.name}</Title>
            <Label style={{ color: palette.muted }}>
              {bytes(offer?.size)}
              {offer?.at ? ` · ${clock(offer.at)}` : ''}
            </Label>
          </View>
          <IconButton
            icon={saved ? 'check' : 'download'}
            tone={saved ? palette.green : undefined}
            loading={saving}
            label={saved ? 'In your gallery' : 'Save to gallery'}
            onPress={onSave}
          />
          <IconButton icon="share-2" loading={sharing} label="Share" onPress={onShare} />
        </View>

        <View style={{ flex: 1, overflow: 'hidden', backgroundColor: alpha(palette.darker_background, 0.6), marginBottom: insets.bottom }}>
          {uri ? <Zoomable key={uri} uri={uri} onTap={onClose} /> : null}
        </View>
      </View>
    </Modal>
  )
}
