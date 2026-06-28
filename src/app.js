import { SeamlessPlayer } from './player.js';
import { Timeline } from './timeline.js';
import { VideoExporter } from './exporter.js';

// アプリケーションの状態
let clips = [];
let selectedClipId = null;
let currentVirtualTime = 0;

// UI 要素の取得
const videoImportInput = document.getElementById('video-import');
const btnExport = document.getElementById('btn-export');
const btnPlayPause = document.getElementById('btn-play-pause');
const btnPrevFrame = document.getElementById('btn-prev-frame');
const btnNextFrame = document.getElementById('btn-next-frame');
const btnSplit = document.getElementById('btn-split');
const btnDelete = document.getElementById('btn-delete');
const clipInfoContent = document.getElementById('clip-info-content');
const currentTimeDisplay = document.getElementById('current-time-display');
const totalTimeDisplay = document.getElementById('total-time-display');

const exportModal = document.getElementById('export-modal');
const exportProgressBar = document.getElementById('export-progress');
const exportPercentage = document.getElementById('export-percentage');

// モジュールの初期化
const playerContainer = document.querySelector('.video-container');
const timelineScrollContainer = document.getElementById('timeline-scroll-container');

// プレイヤーコールバック
const player = new SeamlessPlayer(
  playerContainer,
  (time) => {
    // タイムアップデート
    currentVirtualTime = time;
    timeline.updatePlayhead(time);
    updateTimeDisplay(time, player.totalDuration);
    updateSplitButtonState();
  },
  () => {
    // 再生終了時
    updatePlayPauseButton(false);
  }
);

// タイムラインコールバック
const timeline = new Timeline(timelineScrollContainer, {
  pxPerSec: 20,
  onSeek: (time) => {
    player.seek(time);
  },
  onClipSelect: (clipId) => {
    selectClip(clipId);
  },
  onClipTrim: (clipId, start, end, isDragging) => {
    if (isDragging) {
      // トリミングドラッグ中はプレビューに即座に反映させる
      // クリップ情報を一時的に書き換えてプレイヤーにシークを指示
      const tempClips = clips.map(c => {
        if (c.id === clipId) {
          return { ...c, start, end };
        }
        return c;
      });
      player.setClips(tempClips);
      
      // トリミング中の端点をシークする
      // 開始位置が動いているか、終了位置が動いているかを判定し、その位置をプレビューする
      const targetClip = clips.find(c => c.id === clipId);
      const startMoved = Math.abs(targetClip.start - start) > 0.01;
      
      // タイムライン全体の仮想時間における、このクリップの開始位置までの総時間
      let clipStartVirtual = 0;
      for (let i = 0; i < tempClips.length; i++) {
        if (tempClips[i].id === clipId) break;
        clipStartVirtual += (tempClips[i].end - tempClips[i].start);
      }
      
      if (startMoved) {
        player.seek(clipStartVirtual); // 新しい開始点
      } else {
        const duration = end - start;
        player.seek(clipStartVirtual + duration - 0.05); // 新しい終了点の直前
      }
    } else {
      // ドラッグ終了時に本番データを更新
      clips = clips.map(c => {
        if (c.id === clipId) {
          return { ...c, start, end };
        }
        return c;
      });
      updateState();
    }
  },
  onClipsReorder: (newClips) => {
    clips = newClips;
    updateState();
  }
});

const exporter = new VideoExporter();

// アプリ初期化
function init() {
  setupEventListeners();
  updateUI();
  
  // Lucideアイコンの初回反映
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// イベントリスナーの紐付け
function setupEventListeners() {
  // 動画インポート
  videoImportInput.addEventListener('change', handleVideoImport);

  // 再生/一時停止
  btnPlayPause.addEventListener('click', () => {
    player.unlock(); // iPad用の再生制限解除
    if (player.isPlaying) {
      player.pause();
      updatePlayPauseButton(false);
    } else {
      player.play();
      updatePlayPauseButton(true);
    }
  });

  // コマ送り
  btnPrevFrame.addEventListener('click', () => {
    player.pause();
    updatePlayPauseButton(false);
    player.seek(currentVirtualTime - 1 / 30); // 30fpsの1フレーム戻る
  });

  btnNextFrame.addEventListener('click', () => {
    player.pause();
    updatePlayPauseButton(false);
    player.seek(currentVirtualTime + 1 / 30); // 30fpsの1フレーム進む
  });

  // クリップ分割
  btnSplit.addEventListener('click', handleSplit);

  // クリップ削除
  btnDelete.addEventListener('click', handleDelete);

  // 動画書き出し
  btnExport.addEventListener('click', handleExport);
}

// ----------------------------------------------------
// イベントハンドラとビジネスロジック
// ----------------------------------------------------

/**
 * 動画ファイルを読み込み、最初のクリップとして登録する
 */
async function handleVideoImport(e) {
  const file = e.target.files[0];
  if (!file) return;

  // ローディング表示などの代わりにプレースホルダーにテキスト表示
  const placeholderText = document.querySelector('#video-placeholder p');
  if (placeholderText) placeholderText.innerText = '読み込み中...';

  try {
    const objectURL = URL.createObjectURL(file);
    const duration = await getVideoDuration(objectURL);

    const newClip = {
      id: 'clip-' + Date.now() + Math.random().toString(36).substr(2, 9),
      name: file.name,
      file: file,
      objectURL: objectURL,
      duration: duration,
      start: 0,
      end: duration
    };

    clips.push(newClip);
    selectedClipId = newClip.id;

    updateState();
    
    // インポートインプットの値をリセット (同じファイルを再読み込み可能にするため)
    videoImportInput.value = '';
  } catch (err) {
    console.error('Video load error:', err);
    alert('動画の読み込みに失敗しました。対応していないファイルフォーマットの可能性があります。');
    if (placeholderText) placeholderText.innerText = '動画を読み込んで編集を開始してください';
  }
}

/**
 * 動画ファイルの正確な長さを取得するための非同期処理
 */
function getVideoDuration(url) {
  return new Promise((resolve, reject) => {
    const tempVideo = document.createElement('video');
    tempVideo.preload = 'metadata';
    tempVideo.src = url;
    
    tempVideo.onloadedmetadata = () => {
      resolve(tempVideo.duration);
      tempVideo.src = '';
    };

    tempVideo.onerror = (err) => {
      reject(err);
    };
  });
}

/**
 * クリップ分割ロジック
 */
function handleSplit() {
  if (clips.length === 0) return;

  // 再生ヘッドの場所が、どのクリップのどの位置かを特定
  const { index, clipTime } = player.getClipIndexAndTimeAt(currentVirtualTime);
  if (index === -1) return;

  const targetClip = clips[index];
  
  // 分割点の前後が短すぎる場合は分割させない (0.2秒以下)
  const minClipDuration = 0.2;
  if (clipTime - targetClip.start < minClipDuration || targetClip.end - clipTime < minClipDuration) {
    alert('これ以上細かく分割することはできません。');
    return;
  }

  // 分割クリップA (前半部分)
  const clipA = {
    ...targetClip,
    id: 'clip-' + Date.now() + '-a',
    end: clipTime
  };

  // 分割クリップB (後半部分)
  const clipB = {
    ...targetClip,
    id: 'clip-' + Date.now() + '-b',
    start: clipTime
  };

  // 元のクリップと差し替える
  clips.splice(index, 1, clipA, clipB);
  
  // 分割後の後半を選択状態にする
  selectedClipId = clipB.id;

  player.pause();
  updatePlayPauseButton(false);

  updateState();
}

/**
 * 選択中クリップの削除ロジック
 */
function handleDelete() {
  if (!selectedClipId || clips.length === 0) return;

  const index = clips.findIndex(c => c.id === selectedClipId);
  if (index === -1) return;

  // メモリ解放のために必要に応じて URL を revoke するべきだが、
  // 他のクリップで同じ objectURL を使っている可能性があるため、
  // clips 全体を検索して他に使っていなければ revoke する
  const deletedClip = clips[index];
  clips.splice(index, 1);

  const stillExists = clips.some(c => c.objectURL === deletedClip.objectURL);
  if (!stillExists) {
    URL.revokeObjectURL(deletedClip.objectURL);
  }

  // 次の選択クリップを決める
  if (clips.length > 0) {
    // 削除した位置の近くを選択
    const nextSelectIdx = Math.min(index, clips.length - 1);
    selectedClipId = clips[nextSelectIdx].id;
  } else {
    selectedClipId = null;
  }

  player.pause();
  updatePlayPauseButton(false);

  updateState();
}

/**
 * 動画書き出し処理
 */
function handleExport() {
  if (clips.length === 0) return;

  player.pause();
  updatePlayPauseButton(false);

  // モーダル表示
  exportModal.classList.add('active');
  exportProgressBar.style.width = '0%';
  exportPercentage.innerText = '0%';

  // 書出し開始
  exporter.export(
    clips,
    player.totalDuration,
    (percent) => {
      // 進捗
      exportProgressBar.style.width = `${percent}%`;
      exportPercentage.innerText = `${percent}%`;
    },
    (blob) => {
      // 完了
      exportModal.classList.remove('active');
      
      // ダウンロードリンクを生成して発火
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `edited_video_${Date.now()}.mp4`;
      document.body.appendChild(a);
      a.click();
      
      // 後片付け
      setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 100);

      alert('動画の書き出しが完了しました！');
    },
    (err) => {
      // エラー
      exportModal.classList.remove('active');
      alert(`書き出し中にエラーが発生しました: ${err.message}`);
    }
  );
}

/**
 * アプリのステート（データ）が変更された際の全体更新
 */
function updateState() {
  player.setClips(clips);
  timeline.setClips(clips, selectedClipId);
  
  // シーク位置の調整 (全体の長さを超えていれば末尾へ)
  if (currentVirtualTime > player.totalDuration) {
    currentVirtualTime = player.totalDuration;
  }
  player.seek(currentVirtualTime);

  updateUI();
}

// ----------------------------------------------------
// UI描画/更新の補助関数
// ----------------------------------------------------

function selectClip(clipId) {
  selectedClipId = clipId;
  timeline.setClips(clips, selectedClipId);
  updateUI();
}

function updateUI() {
  // ボタン類の活性状態制御
  const hasClips = clips.length > 0;
  btnExport.disabled = !hasClips;
  updateSplitButtonState();
  btnDelete.disabled = !selectedClipId;

  // 選択中クリップの詳細表示
  const activeClip = clips.find(c => c.id === selectedClipId);
  if (activeClip) {
    const startM = Math.floor(activeClip.start / 60).toString().padStart(2, '0');
    const startS = (activeClip.start % 60).toFixed(2).padStart(5, '0');
    
    const endM = Math.floor(activeClip.end / 60).toString().padStart(2, '0');
    const endS = (activeClip.end % 60).toFixed(2).padStart(5, '0');

    const duration = activeClip.end - activeClip.start;
    const durM = Math.floor(duration / 60).toString().padStart(2, '0');
    const durS = (duration % 60).toFixed(2).padStart(5, '0');

    clipInfoContent.className = 'clip-info-detail';
    clipInfoContent.innerHTML = `
      <div class="info-row">
        <span class="info-label">ファイル名</span>
        <span class="info-value" style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${activeClip.name}
        </span>
      </div>
      <div class="info-row">
        <span class="info-label">トリム開始 (In点)</span>
        <span class="info-value">${startM}:${startS}</span>
      </div>
      <div class="info-row">
        <span class="info-label">トリム終了 (Out点)</span>
        <span class="info-value">${endM}:${endS}</span>
      </div>
      <div class="info-row">
        <span class="info-label">クリップ長</span>
        <span class="info-value" style="color: var(--accent-color);">${durM}:${durS}</span>
      </div>
    `;
  } else {
    clipInfoContent.className = 'clip-info-empty';
    clipInfoContent.innerHTML = '<p>タイムライン上のクリップを選択すると詳細が表示されます</p>';
  }

  // 時間表示の更新
  updateTimeDisplay(currentVirtualTime, player.totalDuration);
  
  // 動的アイコン作成
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function updateSplitButtonState() {
  if (clips.length === 0) {
    btnSplit.disabled = true;
    return;
  }
  
  // 再生ヘッドがタイムラインの境界ギリギリにある場合は分割させない
  const { index, clipTime } = player.getClipIndexAndTimeAt(currentVirtualTime);
  if (index === -1) {
    btnSplit.disabled = true;
    return;
  }

  const targetClip = clips[index];
  const margin = 0.2; // 0.2秒未満のクリップは作らせない
  
  const isNearStart = (clipTime - targetClip.start) < margin;
  const isNearEnd = (targetClip.end - clipTime) < margin;
  
  btnSplit.disabled = isNearStart || isNearEnd;
}

function updatePlayPauseButton(isPlaying) {
  if (isPlaying) {
    btnPlayPause.classList.add('playing');
    btnPlayPause.innerHTML = '<i data-lucide="pause"></i>';
  } else {
    btnPlayPause.classList.remove('playing');
    btnPlayPause.innerHTML = '<i data-lucide="play"></i>';
  }
  if (window.lucide) window.lucide.createIcons();
}

function updateTimeDisplay(current, total) {
  const format = (t) => {
    const m = Math.floor(t / 60).toString().padStart(2, '0');
    const s = Math.floor(t % 60).toString().padStart(2, '0');
    const ms = Math.floor((t % 1) * 100).toString().padStart(2, '0');
    return `${m}:${s}.${ms}`;
  };

  currentTimeDisplay.innerText = format(current);
  totalTimeDisplay.innerText = format(total);
}

// アプリの起動
document.addEventListener('DOMContentLoaded', init);
window.addEventListener('load', () => {
  // Safariでvh単位のズレを防ぐための対応
  const resetHeight = () => {
    document.documentElement.style.setProperty('--vh', `${window.innerHeight * 0.01}px`);
  };
  window.addEventListener('resize', resetHeight);
  resetHeight();
});
