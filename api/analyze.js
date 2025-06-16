/**
 * このファイルは /api/analyze.js として配置します。(最終安定版 v5)
 * Vercelサーバーレス環境での起動時の問題を解決するため、ログと安定性を強化した最終バージョンです。
 */
import { execFile } from 'child_process';
import { YtDlp } from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs';

// Vercelのサーバーレス環境で唯一書き込み可能な/tmpディレクトリ
const YTDLP_PATH = path.join('/tmp', 'yt-dlp');

// yt-dlpのダウンロード処理を一度だけ実行するためのシンプルなフラグ
let isYtDlpReady = false;

/**
 * yt-dlpのバイナリが存在することを保証する関数。
 */
async function ensureYtDlpIsReady() {
  // 既に準備完了フラグが立っているか、ファイルが存在すれば何もしない
  if (isYtDlpReady || fs.existsSync(YTDLP_PATH)) {
    isYtDlpReady = true;
    return;
  }
  
  console.log('Analysis engine not ready. Initializing...');
  try {
    // yt-dlpをダウンロードして/tmpに保存
    await YtDlp.downloadFromGithub(YTDLP_PATH);
    // 実行権限を付与
    fs.chmodSync(YTDLP_PATH, '755');
    isYtDlpReady = true; // 準備完了フラグを立てる
    console.log('Analysis engine is now ready.');
  } catch (error) {
    console.error('CRITICAL: Failed to initialize analysis engine:', error);
    // 初期化に失敗したことを示すカスタムエラーを投げる
    throw new Error('ENGINE_INITIALIZATION_FAILED');
  }
}

/**
 * yt-dlpを直接実行して動画情報を取得する関数
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-playlist', '--no-warnings', '--no-check-certificate',
      '--format-sort', 'res,vcodec:h264',
      url
    ];
    execFile(YTDLP_PATH, args, { timeout: 14000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        return reject(error);
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // ステップ1: 解析エンジンの準備
    await ensureYtDlpIsReady();

    // ステップ2: リクエストボディの解析
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { url } = body;
    
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: '無効なURLです。' });
    }
    
    // ステップ3: 動画情報の取得
    const metadata = await getVideoInfo(url);
    
    // ステップ4: 結果の整形
    const result = {
      title: metadata.title,
      thumbnailUrl: metadata.thumbnail,
      formats: metadata.formats
        .filter(f => ((f.vcodec !== 'none' && f.acodec !== 'none') || (f.vcodec === 'none' && f.acodec !== 'none')) && f.url)
        .map(f => ({
          quality: f.vcodec === 'none' ? `${Math.round(f.abr || 0)}kbps` : `${f.height}p`,
          format: f.vcodec === 'none' ? 'M4A/MP3' : 'MP4',
          url: f.url,
          type: f.vcodec === 'none' ? 'audio' : 'video',
          filesize: f.filesize || f.filesize_approx || 0,
        }))
        .filter(f => f.filesize > 0)
        .reverse()
        .filter((v, i, a) => a.findIndex(t => (t.quality === v.quality && t.format === v.format)) === i),
    };
    
    return res.status(200).json(result);

  } catch (error) {
    // エラーの種類に応じて、より分かりやすいメッセージを返す
    if (error.message === 'ENGINE_INITIALIZATION_FAILED') {
      return res.status(500).json({ error: 'サーバーの初回起動に失敗しました。数秒後にもう一度お試しください。' });
    }
    const stderr = error.stderr || '';
    if (stderr.includes('Unsupported URL')) {
      return res.status(400).json({ error: 'このURLには対応していません。' });
    }
    if (stderr.includes('Private video') || stderr.includes('Video unavailable')) {
      return res.status(403).json({ error: 'この動画は非公開か、利用できません。' });
    }
    return res.status(500).json({ error: '動画情報の解析に失敗しました。タイムアウトしたか、サーバーで問題が発生した可能性があります。' });
  }
}
