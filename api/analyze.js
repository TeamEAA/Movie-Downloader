/**
 * このファイルは /api/analyze.js として配置します。(最終安定版 - バイナリ同梱版)
 * 起動時の問題を根本的に解決するため、yt-dlpをプロジェクトに含める方式に変更します。
 */
import { execFile } from 'child_process';
import path from 'path';

// プロジェクト内の 'bin' ディレクトリにある yt-dlp バイナリのパスを指定
// これにより、実行時のダウンロードが不要になり、動作が安定します。
const YTDLP_PATH = path.resolve(process.cwd(), 'bin/yt-dlp');

/**
 * yt-dlpを直接実行して動画情報を取得する関数
 */
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '--dump-json', '--no-playlist', '--no-warnings', '--no-check-certificate',
      '--format-sort', 'res,vcodec:h264',
      '--no-mtime',
      url
    ];
    // Vercelの最大タイムアウト(15秒)より少し短い時間を設定
    execFile(YTDLP_PATH, args, { timeout: 14000, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          error.message = 'TIMEOUT';
        }
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
  // 以前のダウンロード処理が不要になったため、ハンドラが大幅にシンプルになります。
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const { url } = body;
    
    const isYoutubeUrl = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/.test(url);
    if (!url || !isYoutubeUrl) {
      return res.status(400).json({ error: '現在、YouTubeのURLのみに対応しています。' });
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
    const stderr = error.stderr || '';
    const errorMessage = error.message || '';

    console.error('AN ERROR OCCURRED:', { message: errorMessage, stderr: stderr });
    
    if (errorMessage.includes('TIMEOUT')) {
      return res.status(500).json({ error: '解析に時間がかかりすぎました（タイムアウト）。長い動画や、YouTube側の対策が影響している可能性があります。' });
    }
    if (stderr.includes('ENOENT')) {
      // このエラーは、yt-dlpバイナリが見つからないことを示します。
      return res.status(500).json({ error: 'サーバー内部エラー: 解析エンジンが見つかりません。bin/yt-dlpファイルが正しくアップロードされているか確認してください。' });
    }
    if (stderr.includes('Private video') || stderr.includes('Video unavailable')) {
      return res.status(403).json({ error: 'この動画は非公開か、利用できません。' });
    }

    return res.status(500).json({ error: '解析中に予期せぬ問題が発生しました。' });
  }
}
