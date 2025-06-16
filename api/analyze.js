/**
 * このファイルは /api/analyze.js として配置します。(修正版)
 * サーバーレス環境でyt-dlpを安定動作させるためのコードです。
 */
import { YtDlp } from 'yt-dlp-wrap';
import path from 'path';
import fs from 'fs';

// Vercelのサーバーレス環境では、/tmpディレクトリのみ書き込み可能
const YTDLP_PATH = path.join('/tmp', 'yt-dlp');

/**
 * サーバー起動時に一度だけyt-dlpバイナリをダウンロードする関数
 */
async function downloadYtDlp() {
  // すでにダウンロード済みかチェック
  if (fs.existsSync(YTDLP_PATH)) {
    console.log('yt-dlp is already downloaded.');
    return;
  }
  
  console.log('Downloading yt-dlp...');
  try {
    await YtDlp.downloadFromGithub(YTDLP_PATH);
    // 実行権限を付与
    fs.chmodSync(YTDLP_PATH, '755');
    console.log('yt-dlp downloaded successfully.');
  } catch (error) {
    console.error('Failed to download yt-dlp:', error);
    throw error; // エラーを投げて処理を中断させる
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    // まずyt-dlpバイナリの存在を確認・ダウンロード
    await downloadYtDlp();

    const { url } = JSON.parse(req.body);
    if (!url || !url.startsWith('http')) {
      return res.status(400).json({ error: '無効なURLです。' });
    }
    
    // ダウンロードしたバイナリのパスを指定して実行
    const ytDlp = new YtDlp(YTDLP_PATH);
    
    console.log(`Analyzing URL: ${url}`);
    const metadata = await ytDlp.getVideoInfo(url);
    
    // 必要な情報を抽出・整形
    const result = {
      title: metadata.title,
      thumbnailUrl: metadata.thumbnail,
      formats: metadata.formats
        .filter(f => (f.vcodec !== 'none' && f.acodec !== 'none') || (f.vcodec === 'none' && f.acodec !== 'none'))
        .map(f => {
          const isAudioOnly = f.vcodec === 'none';
          return {
            quality: isAudioOnly ? `${Math.round(f.abr || 0)}kbps` : `${f.height}p`,
            format: isAudioOnly ? 'MP3' : 'MP4',
            url: f.url,
            type: isAudioOnly ? 'audio' : 'video',
            filesize: f.filesize || f.filesize_approx || 0,
          };
        })
        .filter(f => f.filesize > 0) // サイズが0のものは除外
        .reverse()
        .filter((v, i, a) => a.findIndex(t => (t.quality === v.quality && t.format === v.format)) === i),
    };
    
    console.log('Analysis successful.');
    return res.status(200).json(result);

  } catch (error) {
    console.error('Error in handler:', error);
    const stderr = error.stderr || '';
    if (stderr.includes('Unsupported URL')) {
      return res.status(400).json({ error: 'このURLには対応していません。' });
    }
    if (stderr.includes('Private video') || stderr.includes('Video unavailable')) {
      return res.status(403).json({ error: 'この動画は非公開か、利用できません。' });
    }
    return res.status(500).json({ error: '動画情報の解析に失敗しました。' });
  }
}
