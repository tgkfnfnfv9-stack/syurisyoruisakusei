# 見積書・報告書 AI取込スキーマ（AI向け説明書）

このファイルは、AI（Muse・ChatGPT・Claude等）が **御見積書** と **作業報告書** のデータを画面操作なしで作るための形式説明です。
AIはこの形式のJSONを作り、**ツールを開くリンク**として返してください（下の「一番早い使い方」）。ユーザーはリンクを押すだけ、または返答をコピーして「🤖 AI取込」→「📋 コピーしたAIの返答を取り込む」を押すだけで全欄に反映されます。

| 書類 | ツール | AI取込を自動で開くURL |
|---|---|---|
| 見積書 | https://tgkfnfnfv9-stack.github.io/syurisyoruisakusei/見積書.html | https://tgkfnfnfv9-stack.github.io/syurisyoruisakusei/見積書.html?ai=1 |
| 報告書 | https://tgkfnfnfv9-stack.github.io/syurisyoruisakusei/報告書メーカー.html | https://tgkfnfnfv9-stack.github.io/syurisyoruisakusei/報告書メーカー.html?ai=1 |

形式は、各ツールの「PDF・データを出力」で保存されるJSON・「📂 読み込み」で読めるJSONと **同一** です。

## 一番早い使い方：リンクで渡す

AIは **JSONを1行にして `encodeURIComponent` したもの** を、ツールのURLの `#ai=` の後ろに付けたリンクを返してください。ユーザーがリンクを押すだけで全欄が埋まった状態で開きます。

```
https://tgkfnfnfv9-stack.github.io/syurisyoruisakusei/%E8%A6%8B%E7%A9%8D%E6%9B%B8.html#ai=<JSON>        ← 見積書
https://tgkfnfnfv9-stack.github.io/syurisyoruisakusei/%E5%A0%B1%E5%91%8A%E6%9B%B8%E3%83%A1%E3%83%BC%E3%82%AB%E3%83%BC.html#ai=<JSON>  ← 報告書
```

- コード実行（Python等）が使えるなら必ずコードで作る：`urllib.parse.quote(json.dumps(data, ensure_ascii=False, separators=(",", ":")), safe="")`
- JavaScriptなら `url + "#ai=" + encodeURIComponent(JSON.stringify(data))`
- base64url（UTF-8）でも読めます。コード実行が使えずリンクを正しく作れない場合は、リンクは省略してJSONだけを返してください
- **リンクと一緒に、同じJSONも ```json のコードブロックで返す**と確実です。リンクが開けなくても、ユーザーは返答をコピーして「📋 コピーしたAIの返答を取り込む」を押すだけで取り込めます（返答全体をコピーしてもJSON・リンクを自動で見つけます）
- `#ai=` 以降はサーバーに送られません（ブラウザ内だけで読み込み、読み込み後はURLから消します）

## 出力ルール（重要）

1. 返すのは上の「リンク」と「JSON（```json）」。説明文があっても取込側で無視しますが、短いほど確実です。
2. **金額の計算はAIがしない。** 交通費・移動費・高速代（税抜換算）・作業費・宿泊費・部品の売価・消費税・合計はツールが自動計算します。AIは「距離・時間・人数・回数・泊数・作業時間・原価」などの **元データだけ** を入れます。
3. 分からない項目は推測で埋めず、省略するか空文字 `""` にする。省略した項目はツールの初期値になります。
4. 日付は `YYYY-MM-DD`、時刻は `HH:MM`（24時間制）。数値は数字の文字列（例 `"36"`、`"1200"`）。カンマや「円」「km」は付けない。
5. チェック項目は `true` / `false`。
6. `id`・`_kkmtRevision`・`directEdits`・`excludedItemKeys`・`signature` は入れない。
7. 取込すると、ツールの現在の入力は貼り付けた内容に **置き換わります**。報告書のお客様サインは取込の後に記入します。

## 共通：拠点（出発地）と移動 — `fields` 内

出発地は3つ。使うものだけ `bX_use: true` にします（初期値は本社だけ `true`）。

| キー | 内容 |
|---|---|
| `b1_use` | 本社（館林）から出発するか |
| `b2_use` | 本庄（児玉）から出発するか |
| `b3_use` / `b3_addr` | その他の出発地を使うか / その住所 |
| `bX_mode` | `"round"`（往復で計算・初期値） / `"oneway"`（片道で計算） |
| `bX_km` | 片道の距離 km |
| `bX_h` | 片道の移動時間 h（例 `"1.5"`） |
| `bX_toll` | 片道の高速代（税込・円）。なければ省略 |
| `bX_people` | 人数（初期値 `"1"`） |
| `bX_vehicles` | 台数（初期値 `"1"`） |
| `bX_tripsWd` | 平日の往復回数（初期値 `"1"`） |
| `bX_tripsWe` | 土日祝の往復回数（初期値 `"0"`） |

`X` は 1・2・3。距離・時間が分からなければ省略してください（ユーザーがツールの「自動取得」で入れます）。

## 共通：部品・その他費用・宿泊

```json
"parts":   [{ "name": "ベアリング 6205", "cost": "8000", "qty": "2" }],
"customs": [{ "name": "産廃処分費", "amt": "5000", "qty": "1" }],
"lodges":  [{ "memo": "11/20〜11/21", "people": "2", "nights": "1", "holiday": false }]
```

| 配列 | キー | 内容 |
|---|---|---|
| `parts` 部品 | `name` / `cost` / `qty` | 品名 / **原価**（売価は原価÷0.8でツールが計算） / 数量。売価を指定したいときだけ `excl` に税抜売価を入れる |
| `customs` その他費用 | `name` / `amt` / `qty` | 品名 / 税抜金額 / 数量 |
| `lodges` 宿泊 | `memo` / `people` / `nights` / `holiday` | 日付・メモ / 人数 / 泊数 / 土日祝の宿泊なら `true` |

宿泊の1泊単価は `fields.lodgeUnit`（初期値 `"15000"`・税抜）。変える必要がなければ省略します。

---

## 見積書（`documentType: "estimate"`）

### fields

| キー | 内容 |
|---|---|
| `mKocon` | 高コン／見積もり番号 |
| `subject` | 件名（例 `"研磨機 クラッチ取り外し"`） |
| `client` | 相手の会社名（「御中」の前） |
| `workDate` | 作業日 `YYYY-MM-DD` |
| `dateType` | `"work"`（作業日・初期値） / `"meeting"`（日にち未定・打ち合わせ） |
| `address` | 作業場所の住所 |
| 拠点 | 上の「共通：拠点」 |
| `workFee` | **通常は入れない**（`wdays` から自動計算）。作業費を固定額にしたいときだけ税抜金額を入れる |

### wdays（作業日ごとの人数・時間）

1日分または同じ条件の作業ごとに1要素。

| キー | 内容 |
|---|---|
| `people` | 人数 |
| `hours` | 通常時間帯の作業時間 h（17:30まで） |
| `night` | 17:30以降の作業時間 h（初期値 `"0"`） |
| `holiday` | 土日祝の作業なら `true` |

### 見積書サンプル

```json
{
  "documentType": "estimate",
  "fields": {
    "mKocon": "245001",
    "subject": "平面研削盤 主軸オーバーホール",
    "client": "岡機械刃物研磨",
    "workDate": "2026-12-03",
    "address": "栃木県小山市城東4-5-1",
    "b1_use": true, "b1_km": "36", "b1_h": "1", "b1_toll": "0", "b1_people": "2", "b1_tripsWd": "2"
  },
  "wdays": [
    { "people": "2", "hours": "7", "night": "0", "holiday": false },
    { "people": "2", "hours": "4", "night": "0", "holiday": false }
  ],
  "parts": [{ "name": "主軸ベアリング", "cost": "24000", "qty": "2" }],
  "customs": [],
  "lodges": []
}
```

---

## 報告書（`documentType: "report"`）

### fields

| キー | 内容 |
|---|---|
| `mKocon` | 高コン番号 |
| `subject` | 件名 |
| `billName` / `billAddr` / `billTel` / `billPerson` | ご請求先の会社名 / 住所 / 電話 / ご担当者様名 |
| `sameAsSite` | 作業場所がご請求先と同じなら `true` |
| `siteName` / `address` / `siteTel` | 作業場所の会社名 / 住所 / 電話（`sameAsSite: true` なら省略） |
| 拠点 | 上の「共通：拠点」 |
| `directUse` / `d_km` / `d_h` / `d_toll` | 拠点を使わず、往復距離・往復時間・高速代の合計を直接入れる場合だけ使う |
| `mMaker` / `mType` / `mNo` / `mYear` | 機械メーカー / 機種 / 機械番号 / 年式 |
| `repDate` | 報告書提出日 `YYYY-MM-DD` |
| `trouble` / `cause` / `action` | 不具合内容 / 原因 / 処置（改行は `\n`） |
| `custSupply` | 部品がお客様支給なら `true` |
| `payDate` | 支払い予定日（例 `"12月末"`） |
| `doneComplete` / `doneIncomplete` | 作業完了なら `doneComplete: true`、未完了なら `doneIncomplete: true`（どちらか一方） |

作業費・日数などの集計欄（`workFee` `daysWd` `daysWe` `hoursPerDay` `nightHours` `workWE` `d_trans` `d_trav` `d_ktoll`）は **入れない**（作業行から自動計算）。

### work（作業行）— 必須

1日・1作業ごとに1要素。

| キー | 内容 |
|---|---|
| `date` | 作業日 `YYYY-MM-DD` |
| `content` | 作業内容（例 `"主軸分解・ベアリング交換"`） |
| `start` / `end` | 時間帯 `HH:MM`（任意） |
| `holiday` | 祝日なら `true`（土日はツールが日付から判定） |
| `people` | 作業者ごとの時間 `[{ "worker": "瑞澤", "hours": "8" }]`。名前が分からなければ `"worker": ""` で時間だけ入れる |

1日8時間を超えた分は、ツールが割増で計算します。

### 報告書サンプル

```json
{
  "documentType": "report",
  "fields": {
    "mKocon": "245001",
    "subject": "平面研削盤 主軸オーバーホール",
    "billName": "岡機械刃物研磨",
    "billAddr": "栃木県小山市城東4-5-1",
    "billTel": "0285-00-0000",
    "billPerson": "岡 様",
    "sameAsSite": true,
    "b1_use": true, "b1_km": "36", "b1_h": "1", "b1_people": "2", "b1_tripsWd": "2",
    "mMaker": "岡本工作機械", "mType": "PSG-63DX", "mNo": "12345", "mYear": "2008",
    "repDate": "2026-12-05",
    "trouble": "主軸回転時に異音",
    "cause": "主軸ベアリングの摩耗",
    "action": "主軸ベアリング交換・試運転確認",
    "doneComplete": true
  },
  "work": [
    { "date": "2026-12-03", "content": "主軸分解・ベアリング交換", "start": "09:00", "end": "17:00",
      "people": [{ "worker": "瑞澤", "hours": "7" }, { "worker": "武藤", "hours": "7" }] },
    { "date": "2026-12-04", "content": "組付け・試運転", "start": "09:00", "end": "13:00",
      "people": [{ "worker": "瑞澤", "hours": "4" }, { "worker": "武藤", "hours": "4" }] }
  ],
  "parts": [{ "name": "主軸ベアリング", "cost": "24000", "qty": "2" }],
  "customs": [],
  "lodges": []
}
```

報告書の「AI取込」には、見積書のJSON（`documentType: "estimate"`）を貼ることもできます。その場合は「📥 見積取込」と同じく報告書へ変換されます。

## AIへの指示テンプレ（ユーザーがコピペで使う用）

各ツールの「🤖 AI取込」→「AIへの指示文をコピー」で、次のような指示文をコピーできます。

> 御見積書（または作業報告書）を作ります。リポジトリ `tgkfnfnfv9-stack/syurisyoruisakusei` の `AI_SCHEMA.md` の形式で、JSONだけを出力してください。金額の計算はしないでください（ツールが自動計算します）。
> 内容：（高コン番号・件名・相手先・作業場所・作業日・人数・作業時間・距離・部品など）
