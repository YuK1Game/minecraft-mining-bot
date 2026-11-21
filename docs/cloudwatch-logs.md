# CloudWatch Logsへの送信

MinecraftBot内のAWS SDKで、BotのログをCloudWatch Logsへ追加送信します。専用のアクセスキーIDとシークレットキーを両方設定したときだけ有効です。空欄なら従来の動作のままで、CloudWatch Agent・AWS CLI・トンネルの導入は不要です。

## 1. AWS側に送信先を用意する

AWSコンソールで一度、次の送信先を作成します。以下の名前は設定例とIAMポリシーで共通です。

| 項目 | 設定例 |
| --- | --- |
| リージョン | 東京 `ap-northeast-1` |
| ロググループ | `/minecraft-bot/personal` |
| ログストリーム | `STORM/bot` |
| ログの保持期間 | 14日を推奨。ロググループで設定 |

Botは送信先を自動作成せず、保持期間も変更しません。送信用のIAMユーザーなどには、作成済みのストリームだけを対象に次のポリシーを設定します。`123456789012` は自分のAWSアカウントIDに置き換えてください。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "WriteMinecraftBotLogs",
      "Effect": "Allow",
      "Action": "logs:PutLogEvents",
      "Resource": "arn:aws:logs:ap-northeast-1:123456789012:log-group:/minecraft-bot/personal:log-stream:STORM/bot"
    }
  ]
}
```

送信だけに必要な権限です。作成・一覧・読み取りの権限や `CloudWatchFullAccess` は不要です。グループ名・ストリーム名・リージョンを変える場合は、AWS上の送信先・次の設定・ポリシーのARNを一致させます。[AWSのアクションとリソースの仕様](https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazoncloudwatchlogs.html)で `PutLogEvents` の対象を確認できます。

## 2. `.env` を設定して再起動する

既存の `.env` に次を追加し、`YOUR_...` を送信用キーの値に置き換えます。キーは手元で入力し、チャットやスクリーンショットには貼らないでください。既存の `BOT_PROFILE` などはそのままにします。

```dotenv
CLOUDWATCH_ACCESS_KEY_ID=YOUR_ACCESS_KEY_ID
CLOUDWATCH_SECRET_ACCESS_KEY=YOUR_SECRET_ACCESS_KEY
CLOUDWATCH_SESSION_TOKEN=
CLOUDWATCH_REGION=ap-northeast-1
CLOUDWATCH_LOG_GROUP=/minecraft-bot/personal
CLOUDWATCH_LOG_STREAM=STORM/bot
```

| 設定 | 未指定時・用途 |
| --- | --- |
| `CLOUDWATCH_ACCESS_KEY_ID` | 空欄。シークレットキーと両方が必要 |
| `CLOUDWATCH_SECRET_ACCESS_KEY` | 空欄。アクセスキーIDと両方が必要 |
| `CLOUDWATCH_SESSION_TOKEN` | 空欄。一時認証情報を使う場合だけ必要 |
| `CLOUDWATCH_REGION` | `ap-northeast-1` |
| `CLOUDWATCH_LOG_GROUP` | `/minecraft-bot/personal` |
| `CLOUDWATCH_LOG_STREAM` | `<PC名>/<BOT_PROFILE>`。`BOT_PROFILE` 未指定時は `main`。例: `STORM/main` |

この機能は `AWS_ACCESS_KEY_ID`・`AWS_SECRET_ACCESS_KEY`・`AWS_PROFILE` や共有認証ファイルを暗黙には使いません。無効に戻すときは専用キー2項目を空欄にして再起動します。一時認証情報を更新したときも再起動が必要です。

初回導入はプロジェクトフォルダで `npm install` を実行し、Bot本体を再起動します。`.env` と接続側の変更はホットリロードされません。以後の設定変更はBot本体の再起動で反映します。

## 3. 送信を確認する

Botを起動し、AWSコンソールで設定したログストリームを開き、新しいBotログが届くことを確認します。届かない場合は、専用キーが両方設定されているか、送信先とIAMポリシーのARNが一致するか、PCの日時が正しいかを確認します。

## 送信する内容と制約

- Botのログ処理に入ったメッセージから、設定した専用キー・session tokenとの完全一致、Bearer・JWT・passwordなどの対象形式をマスクして送信します。既存ダッシュボード向けの本文200文字制限を送信元には使いません。64KiBを超える本文はUTF-8の文字境界で切り詰め、末尾に `[truncated]` を付けます。各イベントに日付を含む発生時刻を付けます。
- 過去の `.local/bot.log` を読み直す機能ではありません。npmの起動前やMicrosoft認証コードなど、プロセスの標準出力全体を捕捉することもありません。
- 通常は5秒ごとに、最大256KiB・1,000件ずつ送ります。1回の通信は最大2秒、同じバッチの送信試行は最大3回です。失敗時は1秒から待ち時間を増やし、上限は60秒です。
- キューは送信量換算（UTF-8本文＋1件26バイト）で、送信待ちと送信中を合わせて最大1MiBです。満杯のときは新しいログのクラウド送信を捨てます。終了時の送信待ちは最大3秒です。AWSが応答内で明示的に拒否したイベントは再送しません。
- 障害が長引く場合やプロセス終了・再起動時には、未送信ログが失われることがあります。未送信データをディスクへ保存して再起動後に再送する機能はありません。再試行の境界で重複する場合もあります。
- 専用キーを設定表示・status・送信の診断ログへ公開しません。本文のマスクはクラウド送信側に適用し、既存のローカルログやstatusの任意の本文まで秘密情報を除去する機能ではありません。送信が失敗してもBotやローカルログは継続します。

CloudWatch Logsへの送信が有効になっても、ChatGPTからの閲覧接続が自動的に増えるわけではありません。こちらから読むには別途、対象ログへの読み取り接続が必要です。

CloudWatchは発生時刻が2時間を超えて未来のログなどを受け付けません。PCの日時を合わせて使用してください。API側の制限は [AWS PutLogEvents](https://docs.aws.amazon.com/AmazonCloudWatchLogs/latest/APIReference/API_PutLogEvents.html) を参照してください。
