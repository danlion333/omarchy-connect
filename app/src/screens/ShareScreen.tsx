import React, { useCallback, useEffect, useState } from 'react'
import { TextInput, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import * as Sharing from 'expo-sharing'
import { Directory, File, Paths } from 'expo-file-system'

import { useConnection } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Divider, Empty, ListRow, Screen, Value } from '../ui/kit'
import { bytes, clock } from '../lib/format'
import { font, radius, size, space } from '../theme'

type InboxItem = { name: string; size: number; at: number }

export function ShareScreen() {
  const { call, client, clipboard, files, palette, status } = useConnection()
  const [draft, setDraft] = useState('')
  const [inbox, setInbox] = useState<InboxItem[]>([])
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

  useEffect(() => {
    loadInbox()
  }, [loadInbox, files.length])

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

  /* ── files ─────────────────────────────────────────────────────────── */

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

  const download = useCallback(
    async (token: string, name: string) => {
      if (!client) return
      setBusy(token)
      try {
        const dir = new Directory(Paths.cache, 'omarchy-connect')
        if (!dir.exists) dir.create({ intermediates: true })
        const target = new File(dir, name)
        if (target.exists) target.delete()
        const file = await File.downloadFileAsync(client.downloadUrl(token), target)
        if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri)
        else report(`saved to ${file.uri}`)
      } catch (err) {
        fail(err)
      } finally {
        setBusy(null)
      }
    },
    [client],
  )

  const offers = files.filter((f) => f.direction === 'out' && f.token)

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
          {offers.map((offer) => (
            <ListRow
              key={offer.token}
              title={offer.name}
              subtitle={bytes(offer.size)}
              onPress={() => download(offer.token!, offer.name)}
              right={<Button icon="download" variant="ghost" loading={busy === offer.token} onPress={() => download(offer.token!, offer.name)} />}
            />
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
    </Screen>
  )
}
