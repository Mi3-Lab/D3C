# How the GPS Map Works (The Simple Version)

## The Big Idea
Your iPhone records where it is every second. This script takes all those locations and makes a video showing the path you took on a map.

---

## Step-by-Step

### 1. **Collect the Dots**
Your iPhone has GPS. It constantly knows your latitude and longitude (like coordinates on a graph). It also knows:
- What time it was
- How fast you were going
- How accurate the reading is

All this data gets saved in a JSON file (just a text file with organized data).

```
Device 1: lat=37.9577, lon=-120.2625, speed=5.2 m/s, time=0ms
Device 1: lat=37.9578, lon=-120.2626, speed=5.1 m/s, time=1000ms
Device 2: lat=37.9580, lon=-120.2623, speed=3.8 m/s, time=0ms
... (thousands more points)
```

---

### 2. **Get the Background Map**
The script downloads map tiles from CartoDB (a map service on the internet). Think of it like this:

- CartoDB has a giant map split into tiny 256×256 pixel squares
- Each square shows roads, buildings, parks, etc.
- The script downloads only the squares it needs for your route
- It saves them to your computer so it doesn't have to download them again

**Real-world analogy:** It's like printing out the right pieces of a Google Map to use as your background.

---

### 3. **Figure Out Where to Put Things**
Now you have:
- GPS coordinates (latitude/longitude)
- A background map image (pixels)

You need to convert from GPS to pixels. The script does math:
- Takes the min/max latitude and longitude
- Picks a "zoom level" (like 12x zoom) that makes your entire route fit nicely on the screen
- Creates a projection that says: "lat 37.9577 goes to pixel position (450, 280)"

**Real-world analogy:** It's like saying "this corner of the map goes here, that corner goes there, now everything else fits in between."

---

### 4. **Draw the Trails**
The script draws a line between each GPS point. But the color depends on **how fast you were going**:

```
Speed colors:
- Blue   = Slow (0 mph)
- Cyan   = Slow-medium (15 mph)
- Green  = Medium (25 mph)
- Yellow = Medium-fast (40 mph)
- Red    = Fast (55+ mph)
```

So fast highways are red, slow city streets are blue.

Each device gets a different colored trail so you can tell them apart.

---

### 5. **Make it Move (Animation)**
Now the script makes a video. For each frame (4 frames per second by default):

1. Figure out where each device is at that exact moment
2. Draw a little circle marker showing the device's current position
3. Draw an arrow showing which direction it's facing
4. Show recent history (last few seconds of trail) around the marker
5. Display speed and accuracy info
6. Show a progress bar at the bottom

Then it sends all these frames to ffmpeg, which combines them into an MP4 video.

**Real-world analogy:** It's like a time-lapse of your journey, with speed information color-coded.

---

## The Files

- **Input:** `session_gps_playback.json` (the raw GPS data from your iPhone)
- **Output:** `session_gps_playback.mp4` (the animated video)
- **Script:** `render_gps_playback.py` (this is what does all the work)
- **Map Service:** CartoDB (downloads the map background)

---

## Why This is Cool

You're turning invisible GPS numbers into a visible story. You can literally see:
- Where you went
- How fast you were going
- When you sped up or slowed down
- How accurate your GPS was

All on a real map with real roads.
