/**
 * このファイルは /api/analyze.js として配置します。(最終診断・安定版 v6)
 * 詳細なエラーロギング機能を追加し、未知のエラーの原因を特定できるようにしたバージョンです。
 */
import { execFile } from 'child_process';
import { YtDlp } from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs';

// Vercelのサーバーレス環境で唯一書き込み可能な/tmpディレクトリ
const YTDLP_PATH = path.join('/tmp', 'yt-dlp');

// yt-dlpの準備が完了したかを保持するフラグ
let isYtDlpReady = false;

/**
 * yt-dlpのバイナリが存在することを保証する関数。
 */
async function ensureYtDlpIsReady() {
  if (isYtDlpReady || fs.existsSync(YTDLP_PATH)) {
    isYtDlpReady = true;
    return;
  }
  
  console.log('Analysis engine not ready. Initializing...');
  try {
    await YtDlp.downloadFromGithub(YTDLP_PATH);
    fs.chmodSync(YTDLP_PATH, '755');
    isYtDlpReady = true;
    console.log('Analysis engine is now ready.');
  } catch (error) {
    console.error('CRITICAL: Failed to initialize analysis engine:', error);
    throw new Error('ENGINE_INITIALIZATION_FAILED');
  }
}

/**
 * yt-dlpを直接実行して動画情報を取得する関数
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    // 互換性を向上させるための引数を追加
    const args = [
      '--dump-json', '--no-playlist', '--no-warnings', '--no-check-certificate',
      '--format-sort', 'res,vcodec:h264',
      '--no-mtime', // ファイルの最終更新日時の設定を無効化
      url
    ];
    execFile(YTDLP_PATH, args, { timeout: 14000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        // エラーオブジェクトにstderr（標準エラー出力）を追加して、より多くの情報を含める
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
  try {
    await ensureYtDlpIsReady();

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { url } = body;
    
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: '無効なURLです。' });
    }
    
    const metadata = await getVideoInfo(url);
    
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
    // --- エラーハンドリングを強化 ---
    const stderr = error.stderr || '';
    const errorMessage = error.message || '';

    // Vercelのログに詳細なエラー情報を記録する
    console.error('AN ERROR OCCURRED:', {
        message: errorMessage,
        stderr: stderr,
        stack: error.stack,
    });
    
    if (errorMessage.includes('ENGINE_INITIALIZATION_FAILED')) {
      return res.status(500).json({ error: 'サーバーの初回起動に失敗しました。数秒後にもう一度お試しください。' });
    }
    if (stderr.includes('Unsupported URL')) {
      return res.status(400).json({ error: 'このURLには対応していません。' });
    }
    if (stderr.includes('Private video') || stderr.includes('Video unavailable')) {
      return res.status(403).json({ error: 'この動画は非公開か、利用できません。' });
    }

    // これまでキャッチできなかった未知のエラーに対して、より具体的なメッセージを返す
    return res.status(500).json({ error: '解析中に予期せぬ問題が発生しました。サイトが対応していない可能性があります。' });
  }
}
