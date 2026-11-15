'use strict'

function displayText (value) {
  return String(value ?? '').replace(/[\p{C}\u00a7]/gu, ' ').slice(0, 200)
}

function describeRealm (realm) {
  return `${displayText(realm.name) || '(名前なし)'}  ID=${realm.id}  ${displayText(realm.state)}${realm.expired ? ' / 期限切れ' : ''}`
}

function printRealms (realms, log = console.log) {
  if (!realms.length) throw new Error('参加済みのRealmが見つかりません。ログインしたアカウントと招待の承認状況を確認してください。')
  realms.forEach((realm, index) => log(`${index + 1}. ${describeRealm(realm)}`))
}

async function chooseRealm (realms, { realmId, ask, log = console.log } = {}) {
  printRealms(realms, log)
  let realm
  if (realmId) {
    realm = realms.find(candidate => String(candidate.id) === String(realmId))
    if (!realm) throw new Error(`REALM_ID=${realmId} は、このアカウントのRealm一覧にありません。`)
  } else {
    if (!ask) throw new Error('対話できるターミナルで起動するか、.envにREALM_IDを設定してください。')
    while (!realm) {
      const answer = (await ask('接続するRealmの番号（qで終了）: ')).trim()
      if (answer.toLowerCase() === 'q') {
        const error = new Error('接続を取り消しました。')
        error.code = 'CANCELLED'
        throw error
      }
      const number = Number(answer)
      if (/^\d+$/.test(answer) && number >= 1 && number <= realms.length) realm = realms[number - 1]
      else log('表示された一覧の番号を入力してください。')
    }
  }
  if (realm.expired || realm.state === 'CLOSED') {
    throw new Error('このRealmは閉じているか期限切れです。通常のマイクラで参加できる状態にしてください。')
  }
  log(`接続先: ${displayText(realm.name)} (ID=${realm.id})`)
  return realm
}

module.exports = { chooseRealm, printRealms, displayText }
