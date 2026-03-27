# Tweet Giffer

A web application that converts Twitter/X tweets into downloadable and shareable GIFs or videos, including all media content (images, videos, GIFs) and audio.

## Features

- Input a Twitter/X URL to process
- Automatically fetches tweet data including media
- Renders the tweet as it appears on Twitter
- Includes all images, videos, GIFs, and audio
- Generates downloadable GIF or video file
- Shareable links for Discord and other platforms

## Setup

### Prerequisites

- Node.js 16 or higher
- FFmpeg installed on your system
- Internet connection

### Installation Steps

1. **Install Node.js dependencies:**
```bash
npm install
```

2. **Install FFmpeg:**
   
   **Windows:**
   - Download FFmpeg from https://www.gyan.dev/ffmpeg/builds/ or https://ffmpeg.org/download.html
   - Extract the zip file to a location like `C:\ffmpeg`
   - Add `C:\ffmpeg\bin` to your system PATH:
     - Open System Properties → Environment Variables
     - Under System Variables, find "Path" and click Edit
     - Click New and add `C:\ffmpeg\bin` (or your installation path)
     - Click OK to save
   - Verify installation by running `ffmpeg -version` in a new terminal
   
   **macOS:**
   ```bash
   brew install ffmpeg
   ```
   
   **Linux (Ubuntu/Debian):**
   ```bash
   sudo apt-get update
   sudo apt-get install ffmpeg
   ```

3. **Start the server:**
```bash
npm start
```

   Or for development with auto-reload:
```bash
npm run dev
```

4. **Open your browser:**
   Navigate to `http://localhost:3000`

## Usage

1. Enter a Twitter/X URL in the input field
2. Click "Create GIF/Video"
3. Wait for processing to complete
4. Download or share the generated file

## Requirements

- Node.js 16+ 
- FFmpeg installed on your system
- Internet connection for fetching tweets
