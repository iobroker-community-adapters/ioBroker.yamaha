# YXC test fixtures

Each `<model>.json` is the `getFeatures` response of a real Yamaha MusicCast
device — the zone/function/input capability report the YXC parser is tested
against without hardware.

The `status/` subfolder holds `getStatus` responses of a single zone (power,
volume, mute, input, sound_program) from the same source — the fixtures the
status parser is tested against.

The responses were recorded by the [`yamaha-yxc-nodejs`](https://github.com/foxthefox/yamaha-yxc-nodejs)
project (foxthefox) and extracted here to the plain getFeatures body. These are
factual protocol responses from the devices, not library source.
