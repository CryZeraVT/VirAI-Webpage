// Demo stand-in for VirCast's Rust audio engine, used only to photograph the UI in a headless browser.
// It answers the same Tauri commands the UI calls, with believable data. Nothing here touches real audio or config.
(() => {
  const COLORS = ['#fa5252', '#228be6', '#40c057', '#fab005', '#be4bdb', '#fd7e14'];
  const NAMES = ['Game Audio', 'Microphone', 'Discord', 'Music', 'Alerts', 'Browser'];
  const DIRS = ['send', 'receive', 'send', 'send', 'send', 'send'];
  const DEV_OUT = ['Speakers (Realtek(R) Audio)', 'Headphones (Arctis Nova Pro)', 'Wave Link Stream (Elgato)', 'VB-Cable Input'];
  const DEV_IN = ['Microphone (Shure MV7+)', 'Line In (Wave XLR)', 'Stereo Mix'];
  const devices = [
    ...DEV_IN.map((n, i) => ({ id: 'in' + i, name: n, kind: 'input', host: 'WASAPI', loopback: false })),
    ...DEV_OUT.map((n, i) => ({ id: 'out' + i, name: n, kind: 'output', host: 'WASAPI', loopback: false })),
    ...DEV_OUT.map((n, i) => ({ id: 'lb' + i, name: n + ' [Loopback]', kind: 'input', host: 'WASAPI', loopback: true })),
  ];
  const net = () => ({ bytes_total: 0, packets_total: 0, bitrate_bps: 0, packets_per_second: 0, packets_lost: 0, packets_reordered: 0, packets_invalid: 0,
    buffer_underruns: 0, buffer_overflows: 0, send_errors: 0, unexpected_sources: 0, source_ip: '', last_packet_age_ms: null });
  const S = {
    lanes: NAMES.map((name, i) => ({
      id: i + 1, name, direction: DIRS[i], running: false, busy: false, recovering: false, muted: false, force_mono: i === 1, gain_db: 0, meter: 0,
      color: COLORS[i], last_error: '', device_id: DIRS[i] === 'send' ? 'lb' + (i % 4) : 'out2', device_name: '', listen_ip: '0.0.0.0', listen_port: 4010 + i,
      remote_ip: '192.168.1.42', remote_port: 4010 + i, latency: 'balanced_100', listen_device_id: '', listen_device_name: '', monitoring: false, warnings: [], network: net(),
    })),
    mixer: { running: false, busy: false, meter: 0, force_mono: true, input_id: 'in0', input_name: DEV_IN[0], output_id: 'out2', output_name: DEV_OUT[2],
      processing: { enabled: true, preset: 'Broadcast', eq_enabled: true, eq_low_db: 2, eq_mid_db: 0, eq_high_db: 3, gate_enabled: true, gate_threshold_db: -48,
        compressor_enabled: true, compressor_threshold_db: -20, compressor_ratio: 3, makeup_gain_db: 4, limiter_enabled: true, limiter_drive_db: 2, limiter_ceiling_db: -1,
        reverb_enabled: false, reverb_mix: 0.1, echo_enabled: false, echo_delay_ms: 220, echo_feedback: 0.25, echo_mix: 0.15 }, last_error: '', warnings: [] },
    profile: { active: 'Stream Night', names: ['Stream Night', 'Podcast', 'Just Chatting'], unsaved: false },
    warnings: [],
    pairing: { state: 'idle', peer_ip: '', peer_name: '', message: 'Ready for local audio' },
  };
  S.lanes.forEach(l => { const d = devices.find(x => x.id === l.device_id); l.device_name = d ? d.name : ''; });
  const PEER = { hostname: 'STREAM-PC', ips: ['192.168.1.42'], source_ip: '192.168.1.42' };
  let scanDelay = 900;
  // meters that move like real programme audio: a slow envelope plus fast jitter
  const t0 = performance.now();
  function tick() {
    const t = (performance.now() - t0) / 1000;
    S.lanes.forEach((l, i) => {
      if (!l.running || l.muted) { l.meter = 0; l.network = net(); return; }
      const env = 0.45 + 0.3 * Math.sin(t * (0.7 + i * 0.23) + i) + 0.15 * Math.sin(t * 3.1 + i * 2);
      l.meter = Math.max(0.05, Math.min(0.98, env + (Math.random() - 0.5) * 0.18));
      const n = l.network; n.bitrate_bps = 1536000 + Math.round(Math.random() * 9000); n.packets_per_second = 200; n.packets_total += 16; n.bytes_total += 30720;
      n.source_ip = l.direction === 'receive' ? '192.168.1.42' : ''; n.last_packet_age_ms = 3 + Math.round(Math.random() * 4);
    });
    const m = S.mixer; m.meter = m.running ? Math.max(0.05, Math.min(0.95, 0.5 + 0.35 * Math.sin(t * 1.9) + (Math.random() - 0.5) * 0.25)) : 0;
  }
  setInterval(tick, 60);
  const clone = o => JSON.parse(JSON.stringify(o));
  const lane = id => S.lanes.find(l => l.id === id);
  const handlers = {
    get_snapshot: () => clone(S),
    list_audio_devices: () => devices,
    start_lane: ({ id }) => { lane(id).running = true; },
    stop_lane: ({ id }) => { lane(id).running = false; },
    start_lane_monitor: ({ id }) => { lane(id).monitoring = true; },
    stop_lane_monitor: () => { S.lanes.forEach(l => (l.monitoring = false)); },
    patch_lane: ({ id, patch }) => { Object.assign(lane(id), patch); },
    start_mixer: () => { S.mixer.running = true; },
    stop_mixer: () => { S.mixer.running = false; },
    patch_mixer: ({ patch }) => { Object.assign(S.mixer, patch); },
    save_profile: () => 'Profile saved', reload_profile: () => 'Profile reloaded', switch_profile: ({ name }) => { S.profile.active = name; return 'Switched to ' + name; },
    new_profile: ({ name }) => name, rename_profile: ({ name }) => name, delete_profile: () => '', source_sync: () => 'Sources synced',
    scan_peers: () => new Promise(r => setTimeout(() => r([PEER]), scanDelay)),
    local_addresses: () => ['192.168.1.174'],
    pair_peer: ({ remoteIp }) => { S.pairing = { state: 'pairing', peer_ip: remoteIp, peer_name: 'STREAM-PC', message: 'Connecting…' };
      setTimeout(() => { S.pairing = { state: 'confirmed', peer_ip: remoteIp, peer_name: 'STREAM-PC', message: 'Connected' }; }, 1400); return 'Pairing with STREAM-PC'; },
    control_paired_lane: ({ id, running }) => { lane(id).running = running; return running ? 'Started on both PCs' : 'Stopped on both PCs'; },
    control_paired_all: ({ running }) => { S.lanes.forEach(l => (l.running = running)); return 'OK'; },
    control_local_all: ({ running }) => { S.lanes.forEach(l => (l.running = running)); return running ? 'Started 6 channels' : 'Stopped 6 channels'; },
    control_remote_all: () => 'OK',
    set_compact_mode: () => {}, install_streamdeck_plugin: () => {},
    'plugin:autostart|is_enabled': () => true, 'plugin:autostart|enable': () => {}, 'plugin:autostart|disable': () => {},
  };
  let cb = 1;
  window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => { const h = handlers[cmd]; if (!h) { console.warn('mock: unhandled', cmd); return null; } return h(args || {}); },
    transformCallback: (fn) => { const id = cb++; window['_' + id] = fn; return id; },
    convertFileSrc: (p) => p, metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  };
  // hooks for the capture script to stage states
  window.__vc = { S, handlers, setScanDelay: ms => (scanDelay = ms) };
})();
