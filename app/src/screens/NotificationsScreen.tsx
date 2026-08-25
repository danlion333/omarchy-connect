import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshControl, TextInput, View } from 'react-native'

import { useConnection } from '../state/ConnectionContext'
import { Body, Button, Caps, Card, CardHeader, Divider, Empty, ListRow, Screen } from '../ui/kit'
import type { NotificationItem } from '../api/client'
import { ago } from '../lib/format'
import { font, radius, size, space } from '../theme'

const URGENCY_LABEL = ['low', 'normal', 'critical']

export function NotificationsScreen() {
  const { call, notifications, markNotificationsRead, palette, status } = useConnection()
  const [history, setHistory] = useState<NotificationItem[]>([])
  const [refreshing, setRefreshing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const connected = status === 'connected'

  const load = useCallback(async () => {
    if (!connected) return
    setRefreshing(true)
    try {
      const res = await call<{ items: NotificationItem[] }>('notifications.list', { limit: 50 })
      setHistory(res.items)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRefreshing(false)
    }
  }, [call, connected])

  useEffect(() => {
    load()
    markNotificationsRead()
    // markNotificationsRead is stable enough for a mount-time read receipt
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  /* Live events arrive before the history file listing catches up, so merge. */
  const merged = useMemo(() => {
    const seen = new Set<string>()
    return [...notifications, ...history]
      .filter((n) => {
        const key = `${n.id}-${n.timestamp}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 80)
  }, [notifications, history])

  const send = useCallback(async () => {
    const summary = draft.trim()
    if (!summary) return
    setBusy(true)
    setError(null)
    try {
      await call('notifications.send', { summary, body: 'sent from your phone' })
      setDraft('')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }, [call, draft])

  return (
    <Screen refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={palette.muted} />}>
      <Caps style={{ marginBottom: space.md }}>Notifications</Caps>

      <Card>
        <CardHeader icon="bell" title="Push to desktop" subtitle="raises a desktop notification" />
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Remind the desktop about something"
          placeholderTextColor={palette.muted}
          style={{
            color: palette.light_foreground,
            fontFamily: font.regular,
            fontSize: size.body,
            backgroundColor: palette.darker_background,
            borderColor: palette.lighter_background,
            borderWidth: 1,
            borderRadius: radius.sm,
            padding: space.md,
            marginBottom: space.md,
          }}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <Button icon="send" label="Send" onPress={send} loading={busy} disabled={!connected || !draft.trim()} variant="solid" />
        {error ? (
          <Body tone={palette.red} style={{ marginTop: space.sm, fontSize: size.label }}>
            {error}
          </Body>
        ) : null}
      </Card>

      <Card>
        <CardHeader icon="inbox" title="Desktop history" subtitle={`${merged.length} notifications`} />
        {merged.length ? (
          merged.map((item, i) => (
            <View key={`${item.id}-${item.timestamp}`}>
              {i > 0 ? <Divider style={{ marginVertical: space.xs }} /> : null}
              <ListRow
                title={item.summary || item.app}
                subtitle={[item.body?.replace(/\s+/g, ' ').trim(), `${item.app} · ${ago(item.timestamp)}`]
                  .filter(Boolean)
                  .join('\n')}
                tone={item.urgency >= 2 ? palette.red : undefined}
                right={
                  item.urgency >= 2 ? <Caps tone={palette.red}>{URGENCY_LABEL[item.urgency] ?? 'urgent'}</Caps> : undefined
                }
              />
            </View>
          ))
        ) : (
          <Empty icon="bell-off" text="Nothing from the desktop yet" />
        )}
      </Card>
    </Screen>
  )
}
