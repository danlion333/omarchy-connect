package expo.modules.omarchylink

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.params.StreamConfigurationMap
import android.media.Image
import android.media.ImageReader
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Range
import android.util.Size
import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs

/**
 * The phone's camera, as a stream rather than as a photograph.
 *
 * The sibling of `Mic`, and written to the same brief: open one input at one
 * format, read it on threads of its own, and hand whole frames to whoever set
 * `onFrame`. It does no compositing, no preview, no face detection and no
 * buffering across a broken link — a picture that has nowhere to go is dropped
 * by the layer above rather than stored by this one, because a picture that
 * missed its moment is worth even less than the sound that did.
 *
 * ## Why Camera2 and not CameraX or `expo-camera`
 *
 * `expo-camera` is in this app already, for the pairing QR scanner, and it is
 * the wrong tool for exactly the reason `expo-audio` was: what it hands back
 * is a finished picture or a preview on a screen, and there is no screen here.
 * The whole point of this road is that the desktop can ask while the phone is
 * face down on a table. CameraX would do it, and would also drag a lifecycle
 * owner into a foreground service that deliberately has no activity. Camera2's
 * `ImageReader` is the layer underneath both, gives out frames as they arrive,
 * and needs nothing but a `Context` and a `Handler`.
 *
 * ## Why YUV and a hand-rolled JPEG rather than an ImageFormat.JPEG reader
 *
 * `ImageFormat.JPEG` on an `ImageReader` is the obvious choice and it is the
 * still-capture path: the device encodes with its full pipeline, which on this
 * handset means a couple of hundred milliseconds a frame and a repeating
 * request that stutters. `YUV_420_888` is the streaming format every Camera2
 * device supports, and `YuvImage.compressToJpeg` is a hardware-backed encoder
 * that runs in single-digit milliseconds at 640×480. The conversion between
 * them — `NV21` — is the twenty lines below, and it is the one place where a
 * plane's `rowStride` and `pixelStride` have to be read rather than assumed.
 * Assuming them is the classic way to produce a green-striped image on exactly
 * the handsets nobody tested on.
 *
 * ## Why the pictures are encoded on a thread of their own
 *
 * Because the `ImageReader` listener runs on one handler, and everything done
 * inside it is time the reader is not draining the queue. Converting to NV21
 * and compressing a JPEG takes single-digit milliseconds at 640×480; at 15 a
 * second that is a tenth of the budget, and it lands squarely on the thread
 * the camera hands frames to. So the listener does almost nothing — take the
 * newest image, decide whether it is owed, hand it on — and a second handler
 * does the work. At most one picture is in flight, which is the backpressure
 * this road already wanted: while the encoder is busy the listener drops what
 * arrives, and drops it *without* moving `seq`, because a frame nobody chose
 * to send is not a hole the desktop should count.
 *
 * ## Why the rate is a schedule and not an interval
 *
 * `1000 / 15` is 66 in whole milliseconds and 66.67 in real ones, and a gate
 * written as "has it been 66 ms since the last one" against a sensor arriving
 * every 33.3 ms takes frames at 66.6 and then 133.3 — every other one — for
 * about eleven a second when fifteen were asked for. The fix is to keep the
 * *schedule* rather than the last arrival: a frame is owed at 0, 66.67,
 * 133.33, and one that turns up a little before its slot fills it rather than
 * being thrown away. `SLACK` is how early that may be.
 *
 * ## Why the foreground service type matters here
 *
 * The same reason it does for the microphone, one rung further up. From
 * Android 14 a foreground service that uses the camera must declare
 * `foregroundServiceType="camera"` and hold `FOREGROUND_SERVICE_CAMERA`, or
 * the system stops the capture the moment the app is no longer visible.
 * `LinkService.holdCamera` claims that type on the service that already
 * exists, and it is asked *before* the device is opened, because the ordering
 * is the whole of what the system checks.
 */
internal object Camera {
  /** Bounds on what a caller may ask for. Mirrors `daemon/src/lib/video.js`. */
  private const val MIN_WIDTH = 160
  private const val MAX_WIDTH = 1920
  private const val MIN_HEIGHT = 120
  private const val MAX_HEIGHT = 1080
  private const val MIN_FPS = 1
  private const val MAX_FPS = 30

  /**
   * How many frames the reader will hold before the driver has to wait.
   *
   * Three. Two is enough for a reader that keeps up and leaves nothing for the
   * frame being encoded; more than three is a queue of pictures nobody will
   * ever send, because `acquireLatestImage` throws away everything but the
   * newest anyway. That discarding is deliberate backpressure: when the encode
   * or the socket falls behind, the phone skips to *now* rather than falling
   * further behind while sending history.
   */
  private const val MAX_IMAGES = 3

  /**
   * How early a frame may be and still count as the one that was owed.
   *
   * A third of the period. The sensor does not arrive on the desktop's grid —
   * it arrives on its own, and at whatever rate the driver settled on — so the
   * question at each slot is "is this the frame for it", not "is it late
   * enough". A third is wide enough to take the frame before the slot when the
   * sensor is running at exactly the rate asked for and drifting against it,
   * and narrow enough that a sensor running at double the rate still has one
   * of its two frames fall outside every slot.
   */
  private const val SLACK = 3

  /** One frame, as JPEG bytes. They cross the bridge as bytes, not base64. */
  @Volatile
  var onFrame: ((ByteArray, Int) -> Unit)? = null

  /** Filming ended without being asked to. Empty reason means it was asked. */
  @Volatile
  var onStopped: ((String) -> Unit)? = null

  private val running = AtomicBoolean(false)
  private var device: CameraDevice? = null
  private var session: CameraCaptureSession? = null
  private var reader: ImageReader? = null
  private var thread: HandlerThread? = null
  private var handler: Handler? = null
  private var encoder: HandlerThread? = null
  private var encodeHandler: Handler? = null

  val isRunning: Boolean
    get() = running.get()

  fun hasPermission(context: Context): Boolean =
    context.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

  /**
   * Open the camera and start emitting frames. Returns false when it could
   * not, which the module turns into the sentence the desktop prints.
   *
   * Idempotent in the only direction that matters: a second start while one is
   * running answers true, because the desktop asking twice for something it
   * already has should not cost it the stream it has.
   *
   * Asynchronous underneath and synchronous on the surface. Camera2 opens a
   * device through a callback, and the caller — the desktop's own instruction,
   * with fifteen seconds on it — wants to know whether there will be pictures.
   * So this blocks the calling thread until the session is configured or has
   * failed, with a ceiling of its own well under the desktop's.
   */
  fun start(context: Context, facing: String, width: Int, height: Int, fps: Int, quality: Int): Boolean {
    if (running.get()) return true
    if (!hasPermission(context)) {
      Trace.warn("camera.start.refused", "reason" to "no-permission")
      return false
    }

    val manager = context.getSystemService(Context.CAMERA_SERVICE) as? CameraManager
    if (manager == null) {
      Trace.warn("camera.start.refused", "reason" to "no-camera-service")
      return false
    }
    val wantFront = facing.equals("front", ignoreCase = true)
    val id = pick(manager, wantFront)
    if (id == null) {
      Trace.warn("camera.start.refused", "reason" to "no-such-camera", "front" to wantFront)
      return false
    }

    // The type has to be held before the device is opened, not after: what
    // Android 14 checks is whether the service was already allowed to use a
    // camera at the moment the capture starts.
    LinkService.holdCamera(true)

    val size = closest(manager, id, width.coerceIn(MIN_WIDTH, MAX_WIDTH), height.coerceIn(MIN_HEIGHT, MAX_HEIGHT))
    val rate = fps.coerceIn(MIN_FPS, MAX_FPS)
    val range = fpsRange(manager, id, rate)
    val jpegQuality = quality.coerceIn(1, 100)

    val worker = HandlerThread("omarchy-camera").also { it.start() }
    thread = worker
    val post = Handler(worker.looper)
    handler = post

    // The second thread, and the whole reason the listener above stays short.
    val encodes = HandlerThread("omarchy-camera-encode").also { it.start() }
    encoder = encodes
    val work = Handler(encodes.looper)
    encodeHandler = work

    val images = ImageReader.newInstance(size.width, size.height, ImageFormat.YUV_420_888, MAX_IMAGES)
    reader = images
    running.set(true)
    // Read and written on the encoder thread only, one picture at a time, so
    // the numbers a capture is sent under are the order they were taken in.
    var seq = 0
    val scratch = Scratch()
    // Whether the encoder still has the last picture. The only thing the two
    // threads say to each other.
    val busy = AtomicBoolean(false)
    // The grid: milliseconds at which a frame is owed. See `SLACK`.
    val period = 1000.0 / rate
    var due = -1.0

    images.setOnImageAvailableListener({ source ->
      // `acquireLatestImage` and not `acquireNextImage`: everything older than
      // the newest picture is thrown away by the reader itself, which is the
      // backpressure this road wants. See `MAX_IMAGES`.
      val image = try {
        source.acquireLatestImage()
      } catch (error: Exception) {
        null
      } ?: return@setOnImageAvailableListener
      // Set only when the encoder took it, because whoever holds the picture
      // closes it and there is exactly one of them.
      var handed = false
      try {
        if (!running.get()) return@setOnImageAvailableListener
        val now = System.currentTimeMillis().toDouble()
        // Owed, or not yet. Deliberately *without* touching `seq`: a frame this
        // code chose not to send is not a hole the desktop should count. A hole
        // is a frame that was meant to go and could not.
        if (due > 0 && now + SLACK < due) return@setOnImageAvailableListener
        // The encoder is still on the previous picture. Skipping to *now* is
        // the right answer for live pictures, and the slot is left standing so
        // the next frame to arrive fills it rather than waiting for the one
        // after.
        if (!busy.compareAndSet(false, true)) return@setOnImageAvailableListener
        // Advance along the grid rather than from this arrival, so a frame
        // taken a little early does not push every later slot early with it. A
        // capture that fell far behind — the encoder stalled, the phone was
        // asleep — starts a fresh grid instead of racing to catch up.
        due = if (due < 0 || due + period <= now) now + period else due + period
        handed = true
        work.post {
          try {
            if (!running.get()) return@post
            val jpeg = encode(image, jpegQuality, scratch) ?: return@post
            val sink = onFrame
            if (sink == null) {
              // Nobody to send to. Not an error, and the layer above stops on
              // its own the moment its socket goes; this is only the window
              // before it notices. Counted as a hole, because from the
              // desktop's side that is exactly what it is.
              seq += 1
              return@post
            }
            try {
              sink(jpeg, seq)
            } catch (error: Exception) {
              Trace.warn("camera.frame.failed", "error" to error.javaClass.simpleName)
            }
            seq += 1
          } finally {
            try {
              image.close()
            } catch (error: Exception) {
              /* already closed, or the reader is going away underneath us */
            }
            busy.set(false)
          }
        }
      } finally {
        if (!handed) {
          try {
            image.close()
          } catch (error: Exception) {
            /* already closed, or the reader is going away underneath us */
          }
        }
      }
    }, post)

    val opened = java.util.concurrent.CountDownLatch(1)
    var ok = false

    try {
      manager.openCamera(
        id,
        object : CameraDevice.StateCallback() {
          override fun onOpened(camera: CameraDevice) {
            device = camera
            try {
              configure(camera, images, range, jpegQuality) { good ->
                ok = good
                opened.countDown()
              }
            } catch (error: Exception) {
              Trace.fail("camera.configure.failed", error)
              opened.countDown()
            }
          }

          override fun onDisconnected(camera: CameraDevice) {
            Trace.warn("camera.disconnected")
            opened.countDown()
            ended("the camera was taken by something else on the phone")
          }

          override fun onError(camera: CameraDevice, error: Int) {
            Trace.warn("camera.error", "code" to error)
            opened.countDown()
            ended("the phone's camera reported error $error")
          }
        },
        post,
      )
    } catch (error: Exception) {
      // A SecurityException here means the permission went away between the
      // check above and this line, which a one-time grant can genuinely do.
      Trace.fail("camera.open.failed", error)
      teardown()
      return false
    }

    // Well under the fifteen seconds the desktop is holding its request open,
    // so a handset that cannot open its camera says so rather than being timed
    // out on.
    val settled = try {
      opened.await(8, java.util.concurrent.TimeUnit.SECONDS)
    } catch (error: InterruptedException) {
      false
    }
    if (!settled || !ok) {
      Trace.warn("camera.start.refused", "reason" to if (settled) "session-failed" else "timeout")
      teardown()
      return false
    }

    Trace.evt(
      "camera.start",
      "front" to wantFront,
      "w" to size.width,
      "h" to size.height,
      "fps" to rate,
      "ae" to "${range.lower}-${range.upper}",
      "q" to jpegQuality,
    )
    return true
  }

  /**
   * The frame-rate range to ask the device's auto-exposure for.
   *
   * Asking for `Range(fps, fps)` and hoping is what this did first, and it is
   * wrong on most handsets: a device only honours a range it published in
   * `CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES`, and one that never offered a
   * fixed fifteen is free to settle wherever it likes — often at seven in a
   * dim room, which no amount of throttling upstream can turn back into
   * fifteen. So the ranges are read and one is picked, in the order that
   * matters: the fixed one if it exists; else the narrowest that never drops
   * below what was asked for; else the one that can at least reach it and
   * sits closest to it; else whatever is fastest and let the gate above sort
   * it out. Arriving too fast costs a dropped frame, arriving too slowly
   * costs the picture.
   */
  private fun fpsRange(manager: CameraManager, id: String, fps: Int): Range<Int> {
    val ranges = try {
      manager.getCameraCharacteristics(id).get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES)
    } catch (error: Exception) {
      Trace.warn("camera.fps.failed", "error" to error.javaClass.simpleName)
      null
    }
    if (ranges == null || ranges.isEmpty()) return Range(fps, fps)
    return ranges.firstOrNull { it.lower == fps && it.upper == fps }
      ?: ranges.filter { it.lower >= fps }.minByOrNull { it.upper }
      ?: ranges.filter { it.upper >= fps }.maxByOrNull { it.lower }
      ?: ranges.maxByOrNull { it.upper }
      ?: Range(fps, fps)
  }

  /** The repeating request that turns an open device into a stream. */
  private fun configure(camera: CameraDevice, images: ImageReader, fps: Range<Int>, quality: Int, done: (Boolean) -> Unit) {
    val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD).apply {
      addTarget(images.surface)
      set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, fps)
      set(CaptureRequest.JPEG_QUALITY, quality.toByte())
    }
    val callback = object : CameraCaptureSession.StateCallback() {
      override fun onConfigured(configured: CameraCaptureSession) {
        session = configured
        try {
          configured.setRepeatingRequest(request.build(), null, handler)
          done(true)
        } catch (error: Exception) {
          Trace.fail("camera.repeating.failed", error)
          done(false)
        }
      }

      override fun onConfigureFailed(configured: CameraCaptureSession) {
        Trace.warn("camera.session.failed")
        done(false)
      }
    }
    @Suppress("DEPRECATION")
    camera.createCaptureSession(listOf(images.surface), callback, handler)
  }

  /**
   * Give the camera back.
   *
   * Safe to call when nothing is filming, and safe to call twice — both
   * happen, because the desktop asking for a stop and the socket dying are two
   * different roads to the same place and they race.
   */
  fun stop() {
    if (!running.getAndSet(false)) return
    teardown()
    Trace.evt("camera.stop")
  }

  /** The end that nobody asked for: say so once, then tear down. */
  private fun ended(reason: String) {
    if (!running.getAndSet(false)) return
    teardown()
    onStopped?.invoke(reason)
  }

  /**
   * Everything opened, closed, in the order Camera2 wants it and with every
   * step swallowed on its own. A teardown that threw halfway would leave the
   * device held and the next `start` refused for a reason nobody could see.
   */
  private fun teardown() {
    running.set(false)
    try {
      session?.stopRepeating()
    } catch (error: Exception) {
      /* the session is already gone */
    }
    try {
      session?.close()
    } catch (error: Exception) {
      /* the same */
    }
    session = null
    try {
      device?.close()
    } catch (error: Exception) {
      /* the same */
    }
    device = null
    try {
      reader?.close()
    } catch (error: Exception) {
      /* the same */
    }
    reader = null
    try {
      thread?.quitSafely()
    } catch (error: Exception) {
      /* the looper is not ours to argue with */
    }
    thread = null
    handler = null
    // `quitSafely` rather than `quit`: the encoder may be holding the last
    // picture, and a looper killed mid-frame would leave that `Image` open
    // against a reader that is about to be closed.
    try {
      encoder?.quitSafely()
    } catch (error: Exception) {
      /* the same */
    }
    encoder = null
    encodeHandler = null
    LinkService.holdCamera(false)
  }

  /** The first camera facing the way that was asked for. */
  private fun pick(manager: CameraManager, front: Boolean): String? {
    val wanted = if (front) CameraCharacteristics.LENS_FACING_FRONT else CameraCharacteristics.LENS_FACING_BACK
    return try {
      manager.cameraIdList.firstOrNull {
        manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == wanted
      } ?: manager.cameraIdList.firstOrNull()
    } catch (error: Exception) {
      Trace.fail("camera.list.failed", error)
      null
    }
  }

  /**
   * The supported size nearest what was asked for.
   *
   * Nearest by pixel count rather than by either dimension: a camera that
   * offers 4:3 when 16:9 was asked for should hand back the same number of
   * pixels in the shape it has, not the widest thing it owns.
   */
  private fun closest(manager: CameraManager, id: String, width: Int, height: Int): Size {
    val wanted = width.toLong() * height
    return try {
      val map = manager.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
        as? StreamConfigurationMap
      val sizes = map?.getOutputSizes(ImageFormat.YUV_420_888)
      sizes?.minByOrNull { abs(it.width.toLong() * it.height - wanted) } ?: Size(width, height)
    } catch (error: Exception) {
      Trace.warn("camera.sizes.failed", "error" to error.javaClass.simpleName)
      Size(width, height)
    }
  }

  /**
   * Everything one encode needs that the next one can have back.
   *
   * A frame is thirty kilobytes of JPEG out of half a megabyte of NV21, and
   * both of those were being allocated fresh fifteen times a second — half a
   * megabyte of garbage a frame, which is a collection every couple of seconds
   * on nothing but the camera. It all lives on the encoder thread and is
   * touched by nothing else, so it can simply be kept.
   */
  private class Scratch {
    val jpeg = ByteArrayOutputStream(64 * 1024)
    private var nv21 = ByteArray(0)
    private var chromaV = ByteArray(0)
    private var chromaU = ByteArray(0)
    private var luma = ByteArray(0)

    fun nv21(size: Int): ByteArray {
      if (nv21.size != size) nv21 = ByteArray(size)
      return nv21
    }

    fun luma(size: Int): ByteArray {
      if (luma.size < size) luma = ByteArray(size)
      return luma
    }

    fun chroma(size: Int): Pair<ByteArray, ByteArray> {
      if (chromaV.size < size) {
        chromaV = ByteArray(size)
        chromaU = ByteArray(size)
      }
      return chromaV to chromaU
    }
  }

  /**
   * One `YUV_420_888` image as JPEG bytes, or null when it could not be read.
   *
   * The strides are the whole of the difficulty. A plane's rows may be padded
   * (`rowStride` wider than the image), and on the chroma planes the two
   * components may be interleaved in one buffer (`pixelStride` of 2) or held
   * apart in two (`pixelStride` of 1). NV21 wants luma whole followed by
   * V and U interleaved, so both cases are copied out by hand rather than
   * bulk-read. Reading them wrong is what produces the green stripes.
   *
   * What is *not* done by hand any more is the reading itself. This used to
   * ask the chroma `ByteBuffer`s for one byte at a time — 76 800 calls a frame
   * at 640×480, each a bounds-checked virtual call across a direct buffer, and
   * all of it on the thread the camera was trying to hand the next picture to.
   * The layout still has to be honoured byte by byte, but the *bytes* can come
   * across a row at a time into an ordinary `ByteArray`, where the interleave
   * is a loop over two arrays that the JIT can see through. The result is
   * identical, which is the only reason it is worth doing: `Rect`, strides and
   * the V-before-U order below are all unchanged.
   */
  private fun encode(image: Image, quality: Int, scratch: Scratch): ByteArray? {
    return try {
      val width = image.width
      val height = image.height
      val nv21 = scratch.nv21(width * height * 3 / 2)

      val y = image.planes[0]
      val yBuffer = y.buffer
      val yRowStride = y.rowStride
      var at = 0
      if (yRowStride == width) {
        yBuffer.position(0)
        yBuffer.get(nv21, 0, width * height)
        at = width * height
      } else {
        val row = scratch.luma(yRowStride)
        for (line in 0 until height) {
          yBuffer.position(line * yRowStride)
          val take = minOf(yRowStride, yBuffer.remaining())
          yBuffer.get(row, 0, take)
          System.arraycopy(row, 0, nv21, at, width)
          at += width
        }
      }

      val u = image.planes[1]
      val v = image.planes[2]
      val uBuffer = u.buffer
      val vBuffer = v.buffer
      val chromaRowStride = v.rowStride
      val chromaPixelStride = v.pixelStride
      val chromaHeight = height / 2
      val chromaWidth = width / 2
      val (vRow, uRow) = scratch.chroma(chromaRowStride)
      // The last row of a chroma plane is often short by the padding, because
      // the buffer stops at the last real pixel rather than at the end of a
      // notional row. So each row is asked for what is actually there.
      val wanted = (chromaWidth - 1) * chromaPixelStride + 1
      for (line in 0 until chromaHeight) {
        val offset = line * chromaRowStride
        vBuffer.position(offset)
        val vTake = minOf(chromaRowStride, vBuffer.remaining())
        vBuffer.get(vRow, 0, vTake)
        uBuffer.position(offset)
        val uTake = minOf(chromaRowStride, uBuffer.remaining())
        uBuffer.get(uRow, 0, uTake)
        if (vTake < wanted || uTake < wanted) return null
        var from = 0
        for (column in 0 until chromaWidth) {
          // NV21 is V then U, which is the one ordering that trips everybody
          // up: the plane at index 1 is U and the one at index 2 is V, and
          // they go into the buffer the other way round.
          nv21[at] = vRow[from]
          nv21[at + 1] = uRow[from]
          at += 2
          from += chromaPixelStride
        }
      }

      scratch.jpeg.reset()
      val ok = YuvImage(nv21, ImageFormat.NV21, width, height, null)
        .compressToJpeg(Rect(0, 0, width, height), quality, scratch.jpeg)
      if (!ok) null else scratch.jpeg.toByteArray()
    } catch (error: Exception) {
      Trace.warn("camera.encode.failed", "error" to error.javaClass.simpleName)
      null
    }
  }

  /** Whether this build of Android can be asked for a camera at all. */
  val supported: Boolean
    get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP
}
