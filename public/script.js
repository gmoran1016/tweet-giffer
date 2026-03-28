const tweetUrlInput = document.getElementById('tweetUrl');
const processBtn = document.getElementById('processBtn');
const loadingSection = document.getElementById('loadingSection');
const resultSection = document.getElementById('resultSection');
const errorSection = document.getElementById('errorSection');
const errorMessage = document.getElementById('errorMessage');
const gifImg = document.getElementById('gifImg');
const videoPlayer = document.getElementById('videoPlayer');
const webmPlayer = document.getElementById('webmPlayer');
const downloadGifBtn = document.getElementById('downloadGifBtn');
const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const downloadWebmBtn = document.getElementById('downloadWebmBtn');
const copyLinkBtn = document.getElementById('copyLinkBtn');
const shareFormat = document.getElementById('shareFormat');
const shareSection = document.getElementById('shareSection');
const tabButtons = document.querySelectorAll('.tab-btn');
const gifPreview = document.getElementById('gifPreview');
const videoPreview = document.getElementById('videoPreview');
const webmPreview = document.getElementById('webmPreview');

let currentResult = null;

// Tab switching
tabButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;

    tabButtons.forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    gifPreview.classList.remove('active');
    videoPreview.classList.remove('active');
    webmPreview.classList.remove('active');

    if (tab === 'gif') gifPreview.classList.add('active');
    else if (tab === 'video') videoPreview.classList.add('active');
    else if (tab === 'webm') webmPreview.classList.add('active');
  });
});

// Process tweet
processBtn.addEventListener('click', async () => {
  const url = tweetUrlInput.value.trim();
  
  if (!url) {
    showError('Please enter a Twitter/X URL');
    return;
  }

  // Validate URL
  if (!url.includes('twitter.com') && !url.includes('x.com')) {
    showError('Please enter a valid Twitter/X URL');
    return;
  }

  // Hide previous results/errors
  hideAllSections();
  showLoading();

  try {
    processBtn.disabled = true;
    processBtn.textContent = 'Processing...';

    const response = await fetch('/api/process-tweet', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Failed to process tweet');
    }

    // Store result
    currentResult = data;

    // Display results
    displayResults(data);

  } catch (error) {
    console.error('Error:', error);
    showError(error.message || 'Failed to process tweet. Please try again.');
  } finally {
    processBtn.disabled = false;
    processBtn.textContent = 'Create GIF/Video';
    hideLoading();
  }
});

// Display results
function displayResults(data) {
  gifImg.src = data.gif;
  videoPlayer.src = data.video;

  // WebM is optional — hide button and share option if server didn't produce one
  if (data.webm) {
    webmPlayer.src = data.webm;
    downloadWebmBtn.style.display = '';
    // Show WebM option in share dropdown
    shareFormat.querySelector('option[value="webm"]').style.display = '';
  } else {
    webmPlayer.src = '';
    downloadWebmBtn.style.display = 'none';
    // Hide WebM from share dropdown and reset to GIF if it was selected
    const webmOpt = shareFormat.querySelector('option[value="webm"]');
    webmOpt.style.display = 'none';
    if (shareFormat.value === 'webm') shareFormat.value = 'gif';
  }

  resultSection.classList.remove('hidden');
  resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Download GIF
downloadGifBtn.addEventListener('click', () => {
  if (currentResult && currentResult.gif) {
    const link = document.createElement('a');
    link.href = currentResult.gif;
    link.download = `tweet_${currentResult.videoId}.gif`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
});

// Download Video (MP4)
downloadVideoBtn.addEventListener('click', () => {
  if (currentResult && currentResult.video) {
    const link = document.createElement('a');
    link.href = currentResult.video;
    link.download = `tweet_${currentResult.videoId}.mp4`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
});

// Download WebM
downloadWebmBtn.addEventListener('click', () => {
  if (currentResult && currentResult.webm) {
    const link = document.createElement('a');
    link.href = currentResult.webm;
    link.download = `tweet_${currentResult.videoId}.webm`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }
});

// Copy share link
copyLinkBtn.addEventListener('click', async () => {
  if (!currentResult) return;

  const format = shareFormat.value;
  const path = format === 'gif'   ? currentResult.gif
              : format === 'video' ? currentResult.video
              :                      currentResult.webm;

  if (!path) return;

  const shareUrl = `${window.location.origin}/share/${currentResult.videoId}?f=${format}`;
  const formatLabel = format.toUpperCase();

  try {
    await navigator.clipboard.writeText(shareUrl);
  } catch {
    const textArea = document.createElement('textarea');
    textArea.value = shareUrl;
    document.body.appendChild(textArea);
    textArea.select();
    document.execCommand('copy');
    document.body.removeChild(textArea);
  }

  shareSection.querySelector('p').textContent = `${formatLabel} link copied to clipboard!`;
  shareSection.classList.remove('hidden');
  setTimeout(() => shareSection.classList.add('hidden'), 3000);
});

// Show/hide sections
function showLoading() {
  loadingSection.classList.remove('hidden');
}

function hideLoading() {
  loadingSection.classList.add('hidden');
}

function showError(message) {
  errorMessage.textContent = message;
  errorSection.classList.remove('hidden');
  errorSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function hideAllSections() {
  loadingSection.classList.add('hidden');
  resultSection.classList.add('hidden');
  errorSection.classList.add('hidden');
  shareSection.classList.add('hidden');
}

// Allow Enter key to submit
tweetUrlInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    processBtn.click();
  }
});
