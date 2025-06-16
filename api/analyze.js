/**
 * このファイルは /api/analyze.js として配置します。(最終修正版 v3)
 * サーバーレス環境での起動時エラーを解消するための最終安定版です。
 */
import { execFile } from 'child_process';
import { YtDlp } from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs';

// Vercelのサーバーレス環境で唯一書き込み可能な/tmpディレクトリ
const YTDLP_PATH = path.join('/tmp', 'yt-dlp');

/**
 * サーバー起動時に一度だけyt-dlpバイナリをダウンロードする関数
 * 멱등성(何度実行しても同じ結果になること)を保証します。
 */
const downloadYtDlp = async () => {
  // すでにファイルが存在すれば、何もしない
  if (fs.existsSync(YTDLP_PATH)) {
    return;
  }
  
  console.log('yt-dlp does not exist. Downloading...');
  try {
    // yt-dlpをダウンロードして/tmpに保存
    await YtDlp.downloadFromGithub(YTDLP_PATH);
    // 実行権限を付与
    fs.chmodSync(YTDLP_PATH, '755');
    console.log('yt-dlp downloaded successfully.');
  } catch (error) {
    console.error('Failed to download or set permissions for yt-dlp:', error);
    // ここでエラーを投げることで、後続の処理を中断し、ハンドラのエラー処理に移行させる
    throw new Error('Failed to prepare yt-dlp executable.');
  }
};

/**
 * yt-dlpを直接実行して動画情報を取得する関数
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json',
      '--no-playlist',
      '--no-warnings',
      '--no-check-certificate',
      '--format-sort', 'res,vcodec:h264',
      url
    ];

    // Vercel Hobbyプランの最大タイムアウトは15秒なので、少し余裕を持たせる
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
  console.log('API handler invoked.');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // APIが呼ばれるたびに、yt-dlpの存在を確認し、なければダウンロードする
    await downloadYtDlp();

    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { url } = body;
    
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: '無効なURLです。' });
    }
    
    console.log(`Analyzing URL: ${url}`);
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
    console.error('Critical error in handler:', { message: error.message, stderr: error.stderr });
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
