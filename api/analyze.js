/**
 * このファイルは /api/analyze.js として配置します。
 * サーバーレス環境でのタイムアウト対策を強化したバージョンです。
 */
import { execFile } from 'child_process';
import { YtDlp } from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs';

// Vercelのサーバーレス環境では、/tmpディレクトリのみ書き込み可能
const YTDLP_PATH = path.join('/tmp', 'yt-dlp');

/**
 * サーバー起動時に一度だけyt-dlpバイナリをダウンロードする関数
 */
let isYtDlpDownloaded = false;
async function downloadYtDlp() {
  // 既にダウンロード済みであれば何もしない
  if (isYtDlpDownloaded) return;
  
  // ファイルが物理的に存在する場合も、ダウンロード済みとみなす
  if (fs.existsSync(YTDLP_PATH)) {
    isYtDlpDownloaded = true;
    return;
  }
  
  console.log('Downloading yt-dlp for the first time...');
  try {
    await YtDlp.downloadFromGithub(YTDLP_PATH);
    fs.chmodSync(YTDLP_PATH, '755'); // 実行権限を付与
    isYtDlpDownloaded = true;
    console.log('yt-dlp downloaded successfully.');
  } catch (error) {
    console.error('Failed to download yt-dlp:', error);
    throw error;
  }
}

/**
 * yt-dlpを直接実行して動画情報を取得する関数
 * @param {string} url 動画のURL
 * @returns {Promise<object>} 動画情報のJSONオブジェクト
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    // タイムアウト対策として接続を高速化する引数を追加
    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate', // SSL証明書のチェックをスキップして高速化
      '--format-sort', 'res,vcodec:h264',
      url
    ];

    console.log(`Executing yt-dlp with args: ${args.join(' ')}`);

    // VercelのHobbyプランの最大タイムアウトに近い値に設定
    execFile(YTDLP_PATH, args, { timeout: 14500, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr; // エラーオブジェクトに詳細を添付
        return reject(error);
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed);
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
    // 最初にyt-dlpのダウンロードを試みる
    await downloadYtDlp();

    const { url } = JSON.parse(req.body);
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: '無効なURLです。' });
    }
    
    const metadata = await getVideoInfo(url);
    
    const result = {
      title: metadata.title,
      thumbnailUrl: metadata.thumbnail,
      formats: metadata.formats
        .filter(f => ((f.vcodec !== 'none' && f.acodec !== 'none') || (f.vcodec === 'none' && f.acodec !== 'none')) && f.url)
        .map(f => {
          const isAudioOnly = f.vcodec === 'none';
          return {
            quality: isAudioOnly ? `${Math.round(f.abr || 0)}kbps` : `${f.height}p`,
            format: isAudioOnly ? 'M4A/MP3' : 'MP4',
            url: f.url,
            type: isAudioOnly ? 'audio' : 'video',
            filesize: f.filesize || f.filesize_approx || 0,
          };
        })
        .filter(f => f.filesize > 0)
        .reverse()
        .filter((v, i, a) => a.findIndex(t => (t.quality === v.quality && t.format === v.format)) === i),
    };
    
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error in handler:', {
      message: error.message,
      stderr: error.stderr,
    });
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
