import tjrSessions from './tjr-sessions.pine?raw'

export interface PineScript { id: string; name: string; code: string }

export const SCRIPTS: readonly PineScript[] = [
  { id: 'tjr-sessions', name: 'TJR-Style Sessions', code: tjrSessions },
]
