param([int]$IntervalMs = 50, [int]$ParentPid = 0, [string]$DllPath = '')

# WASAPI loopback features only: RMS, peak and 16 spectrum bands.
# Emits JSON to stdout; no raw audio is stored.
# Derived from dsh-whale-pulse runtime/probe.ps1 (MIT).
# Reads NAudio.dll from PSScriptRoot.
# Keep this script ASCII for Windows PowerShell 5.1 without a UTF-8 BOM.

$ErrorActionPreference = 'Stop'

$dll = if ($DllPath) { $DllPath } else { Join-Path $PSScriptRoot 'NAudio.dll' }
if (-not (Test-Path -LiteralPath $dll)) {
    Write-Output '{"error":"naudio-missing"}'
    exit 1
}
try {
    # LoadFrom fails for this DLL from a non-ASCII path / blocked file (0x80131515).
    # LoadFile from an ASCII temp copy works; keep the copied file for the process lifetime.
    $load = Join-Path $env:TEMP ('NAudio-' + [guid]::NewGuid().ToString('N') + '.dll')
    Copy-Item -LiteralPath $dll -Destination $load -Force -ErrorAction Stop
    [System.Reflection.Assembly]::LoadFile($load) | Out-Null
} catch {
    Write-Output ('{"error":"naudio-load-failed","message":"' + ($_.Exception.Message -replace '"', "'") + '"}')
    exit 1
}

$cs = @'
using System;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.Wave;
using NAudio.CoreAudioApi;
using NAudio.CoreAudioApi.Interfaces;
using NAudio.Dsp;

// Pure monotonic-time policy, also exercised by the isolated replay tests.
public sealed class CaptureHealth
{
    private long _suspectAt = -1;
    private long _checkedAt = -1;

    public bool IsStalled(long now, long lastDataAt, double endpointPeak)
    {
        // Silence, a brief gap or an unreadable meter is not proof of failure.
        // Reset after a long monitor gap (e.g. sleep/resume).
        if (_checkedAt >= 0 && now - _checkedAt > 2500) _suspectAt = -1;
        _checkedAt = now;
        if (double.IsNaN(endpointPeak) || endpointPeak < 0.01 || now - lastDataAt < 1500)
        {
            _suspectAt = -1;
            return false;
        }
        if (_suspectAt < 0) _suspectAt = now;
        return now - _suspectAt >= 6000;
    }
}

public sealed class TopologyHealth
{
    private readonly string _initial;
    private string _pending;
    private long _pendingAt;
    public TopologyHealth(string initial) { _initial = initial; }
    public bool IsChanged(long now, string fingerprint)
    {
        if (fingerprint == null || fingerprint == _initial) { _pending = null; return false; }
        if (fingerprint != _pending) { _pending = fingerprint; _pendingAt = now; return false; }
        return now - _pendingAt >= 1000;
    }
}

public static class WhaleEar
{
    private const int FftSize = 1024;
    private const int FftLog = 10;
    private const int Bands = 16;

    private static readonly object Gate = new object();
    private static readonly float[] Samples = new float[FftSize];
    private static int _pos;
    private static int _parentPid;
    private static double _peak;
    private static double _energy;
    private static long _count;
    private static readonly Stopwatch Clock = Stopwatch.StartNew();

    private sealed class CaptureSlot : IDisposable
    {
        public WasapiLoopbackCapture Capture;
        public string Id;
        public long LastDataAt = Clock.ElapsedMilliseconds;
        public volatile bool Stopped;
        public readonly CaptureHealth Health = new CaptureHealth();
        public void Dispose()
        {
            try { Capture.StopRecording(); } catch { }
            try { Capture.Dispose(); } catch { }
        }
    }

    private sealed class Snapshot : IDisposable
    {
        public readonly System.Collections.Generic.List<MMDevice> All = new System.Collections.Generic.List<MMDevice>();
        public readonly System.Collections.Generic.List<MMDevice> Targets = new System.Collections.Generic.List<MMDevice>();
        public string Fingerprint;
        public void Dispose() { foreach (var device in All) { try { device.Dispose(); } catch { } } }
    }

    public static void Run(int intervalMs, int parentPid)
    {
        _parentPid = parentPid;
        if (intervalMs < 20) intervalMs = 20;
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        var captures = new System.Collections.Generic.List<CaptureSlot>();
        Snapshot initial = null;
        try
        {
            initial = ReadSnapshot();
            var names = new System.Collections.Generic.List<string>();
            foreach (var device in initial.Targets)
            {
                var slot = new CaptureSlot { Id = device.ID };
                try
                {
                    slot.Capture = new WasapiLoopbackCapture(device);
                    var state = slot;
                    slot.Capture.DataAvailable += (sender, e) => {
                        if (e.BytesRecorded > 0) Interlocked.Exchange(ref state.LastDataAt, Clock.ElapsedMilliseconds);
                        OnData(sender, e);
                    };
                    slot.Capture.RecordingStopped += (sender, e) => { state.Stopped = true; };
                    slot.Capture.StartRecording();
                    names.Add(device.FriendlyName);
                }
                catch { slot.Dispose(); slot.Capture = null; }
                // A device that could not start is monitored too: if it later becomes
                // audible, retry instead of leaving it permanently uncaptured.
                captures.Add(slot);
            }
            if (names.Count == 0) { Error("start-failed"); return; }
            Line("{\"ready\":true,\"recovery\":true,\"device\":\"" + Json(string.Join(" + ", names)) + "\"}");

            var topology = new TopologyHealth(initial.Fingerprint);
            var bands = new double[Bands];
            long monitorAt = Clock.ElapsedMilliseconds;
            int monitorErrors = 0;
            string apps = "[]";
            var text = new StringBuilder(260);
            while (true)
            {
                Thread.Sleep(intervalMs);
                if (_parentPid > 0 && !ParentAlive()) return;
                foreach (var slot in captures)
                    if (slot.Capture != null && slot.Stopped) { Error("capture-stopped"); return; }

                double peak, rms;
                TakeFeatures(bands, out peak, out rms);

                long now = Clock.ElapsedMilliseconds;
                if (now - monitorAt >= 1000)
                {
                    monitorAt = now;
                    try
                    {
                        using (var snapshot = ReadSnapshot())
                        {
                            if (topology.IsChanged(now, snapshot.Fingerprint)) { Error("devices-changed"); return; }
                            foreach (var slot in captures)
                            {
                                double meter = double.NaN;
                                foreach (var device in snapshot.Targets)
                                    if (device.ID == slot.Id)
                                    {
                                        try { meter = device.AudioMeterInformation.MasterPeakValue; } catch { }
                                        break;
                                    }
                                if (slot.Health.IsStalled(now, Interlocked.Read(ref slot.LastDataAt), meter))
                                { Error("capture-stalled"); return; }
                            }
                            apps = AppsJson(snapshot.All);
                        }
                        monitorErrors = 0;
                    }
                    catch
                    {
                        // One transient enumeration failure is not a device change.
                        apps = "[]";
                        topology.IsChanged(now, null);
                        if (++monitorErrors >= 3) { Error("device-monitor-failed"); return; }
                    }
                }
                text.Length = 0;
                text.Append("{\"peak\":").Append(F(peak, 4));
                text.Append(",\"rms\":").Append(F(rms, 4));
                text.Append(",\"bands\":[");
                for (int b = 0; b < Bands; b++)
                {
                    if (b > 0) text.Append(',');
                    text.Append(F(bands[b], 3));
                }
                text.Append("],\"apps\":").Append(apps).Append("}");
                Line(text.ToString());
            }
        }
        catch (Exception error)
        {
            Line("{\"error\":\"device-open-failed\",\"message\":\"" + Json(error.Message) + "\"}");
            Environment.ExitCode = 1;
        }
        finally
        {
            foreach (var slot in captures) slot.Dispose();
            if (initial != null) initial.Dispose();
            if (_parentProc != null) _parentProc.Dispose();
        }
    }

    private static void Error(string reason) { Line("{\"error\":\"" + reason + "\"}"); Environment.ExitCode = 1; }

    // Loudest few audio sessions right now: [["spotify",0.42],["chrome",0.11]] (music-app whitelist).
    private static string AppsJson(System.Collections.Generic.List<MMDevice> devices)
    {
        try
        {
            var found = new System.Collections.Generic.Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
            foreach (var device in devices)
            {
                try
                {
                    var sessions = device.AudioSessionManager.Sessions;
                    for (int i = 0; i < sessions.Count; i++)
                    {
                        AudioSessionControl session = null;
                        try
                        {
                            session = sessions[i];
                            if (session.State != NAudio.CoreAudioApi.Interfaces.AudioSessionState.AudioSessionStateActive) continue;
                            double level = session.AudioMeterInformation.MasterPeakValue;
                            if (level < 0.004) continue;
                            uint pid = session.GetProcessID;
                            if (pid == 0) continue;
                            if (pid == (uint)Process.GetCurrentProcess().Id) continue; // Ignore the capture process itself.
                            string name;
                            using (var process = Process.GetProcessById((int)pid)) name = process.ProcessName.ToLowerInvariant();
                            double before;
                            if (!found.TryGetValue(name, out before) || level > before) found[name] = level;
                        }
                        catch { }
                        finally { if (session != null) { try { session.Dispose(); } catch { } } }
                    }
                }
                catch { }
            }
            var list = new System.Collections.Generic.List<System.Collections.Generic.KeyValuePair<string, double>>(found);
            list.Sort((a, b) => b.Value.CompareTo(a.Value));
            var sb = new StringBuilder("[");
            int take = Math.Min(4, list.Count);
            for (int i = 0; i < take; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("[\"").Append(Json(list[i].Key)).Append("\",").Append(F(list[i].Value, 3)).Append(']');
            }
            return sb.Append(']').ToString();
        }
        catch { return "[]"; }
    }
    private static string F(double value, int digits)
    {
        return value.ToString("F" + digits, CultureInfo.InvariantCulture);
    }

    private static void Line(string text)
    {
        Console.WriteLine(text);
        Console.Out.Flush();
    }

    // JSON-escape a string, and keep the whole line pure ASCII: non-ASCII is written as \uXXXX, so the
    // console code page can never turn a device name into mojibake on the way to the host.
    private static string Json(string text)
    {
        if (text == null) return "";
        var sb = new StringBuilder(text.Length + 8);
        foreach (char c in text)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 32 || c > 126) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    // Keep the parent Process object: building a new one every 50 ms cost ~15% of a core.
    private static Process _parentProc;
    private static bool ParentAlive()
    {
        try
        {
            if (_parentProc == null) _parentProc = Process.GetProcessById(_parentPid); return !_parentProc.HasExited;
        }
        catch { return false; }
    }

    // FxSound / Voicemeeter / VB-Audio / CABLE endpoints are pass-through: capturing them gives silence.
    private static bool IsVirtual(string name)
    {
        if (string.IsNullOrEmpty(name)) return false;
        var n = name.ToLowerInvariant();
        return n.Contains("virtual") || n.Contains("fxsound") || n.Contains("voicemeeter")
            || n.Contains("vb-audio") || n.Contains("vb audio") || n.Contains("cable input")
            || n.Contains("cable output") || n.Contains("stereo mix");
    }

    private static Snapshot ReadSnapshot()
    {
        var snapshot = new Snapshot();
        try
        {
            using (var enumerator = new MMDeviceEnumerator())
            {
                string defaultId = "";
                try { using (var device = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia)) defaultId = device.ID; }
                catch { }
                foreach (var device in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
                {
                    snapshot.All.Add(device);
                    if (!IsVirtual(device.FriendlyName)) snapshot.Targets.Add(device);
                }
                if (snapshot.Targets.Count == 0)
                    foreach (var device in snapshot.All) if (device.ID == defaultId) { snapshot.Targets.Add(device); break; }
                var ids = new System.Collections.Generic.List<string>();
                foreach (var device in snapshot.Targets) ids.Add(device.ID);
                ids.Sort(StringComparer.Ordinal);
                snapshot.Fingerprint = defaultId + "|" + string.Join("|", ids);
            }
            return snapshot;
        }
        catch { snapshot.Dispose(); throw; }
    }

    private static void OnData(object sender, WaveInEventArgs e)
    {
        int cnt = e.BytesRecorded / 4;
        double peak = 0, energy = 0;
        lock (Gate)
        {
            for (int i = 0; i < cnt; i++)
            {
                float f = BitConverter.ToSingle(e.Buffer, i * 4);
                Samples[_pos] = f;
                _pos++;
                if (_pos >= FftSize) _pos = 0;
                double v = Math.Abs(f);
                if (v > peak) peak = v;
                energy += v * v;
            }
            if (peak > _peak) _peak = peak;
            _energy += energy;
            _count += cnt;
        }
    }

    private static void TakeFeatures(double[] bands, out double peak, out double rms)
    {
        bool fresh;
        lock (Gate)
        {
            peak = _peak;
            fresh = _count > 0;
            rms = Math.Sqrt(fresh ? _energy / _count : 0);
            _peak = 0;
            _energy = 0;
            _count = 0;
            // Do not replay the old FFT after callbacks stop or playback pauses.
            if (!fresh) Array.Clear(Samples, 0, Samples.Length);
        }
        if (fresh) ComputeBands(bands); else Array.Clear(bands, 0, bands.Length);
    }

    private static void ComputeBands(double[] bands)
    {
        var c = new Complex[FftSize];
        lock (Gate)
        {
            for (int i = 0; i < FftSize; i++)
            {
                int index = (_pos + i) % FftSize;
                double window = 0.54 - 0.46 * Math.Cos(2.0 * Math.PI * i / (FftSize - 1));
                c[i].X = (float)(Samples[index] * window);
                c[i].Y = 0f;
            }
        }
        try { FastFourierTransform.FFT(true, FftLog, c); }
        catch
        {
            for (int b = 0; b < Bands; b++) bands[b] = 0;
            return;
        }
        int lo = 1, hi = FftSize / 2;
        for (int b = 0; b < Bands; b++)
        {
            int a = lo + (hi - lo) * b / Bands;
            int z = lo + (hi - lo) * (b + 1) / Bands;
            double sum = 0;
            int n = 0;
            for (int i = a; i < z; i++)
            {
                sum += Math.Sqrt((double)c[i].X * c[i].X + (double)c[i].Y * c[i].Y);
                n++;
            }
            double avg = n > 0 ? sum / n : 0;
            bands[b] = Math.Min(1.0, Math.Sqrt(avg) * 3.0);
        }
    }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies @($dll, 'System.dll') -Language CSharp

[WhaleEar]::Run($IntervalMs, $ParentPid)
