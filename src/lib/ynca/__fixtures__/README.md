# YNCA test fixtures

Each `<model>.json` is the list of response lines a real Yamaha receiver sent
during the YNCA init sweep (the `@SUBUNIT:FUNC=VALUE` / `@UNDEFINED` /
`@RESTRICTED` lines). They are used to test the protocol decoder and the
capability parser against real device behaviour without hardware.

The raw device logs were recorded by the [`ynca`](https://github.com/mvdwetering/ynca)
project (mvdwetering) and reduced here to the received init-sweep lines. These
are factual protocol responses from the devices, not library source.
