import { CBORItem, CBORItem_, SizeBytes } from "./model";

function parse(stream: Uint8Array): [CBORItem, Uint8Array] {
  switch (stream[0] & 0xf0) {
    case 0x00:
    case 0x10:
      return _parseUInt(stream);
    case 0x20:
    case 0x30:
      return _parseNegInt(stream);
    case 0x40:
    case 0x50:
      return _parseByteString(stream);
    case 0x60:
    case 0x70:
      return _parseTextString(stream);
    case 0x80:
    case 0x90:
      return _parseArray(stream);
    case 0xa0:
    case 0xb0:
      return _parseMap(stream);
    case 0xc0:
    case 0xd0:
      return _parseTagged(stream);
    case 0xf0:
      switch (stream[0] & 0x0f) {
        case 0x04:
          return [{ type: "boolean", value: false }, stream.slice(1)];
        case 0x05:
          return [{ type: "boolean", value: true }, stream.slice(1)];
        case 0x06:
          return [{ type: "null", value: null }, stream.slice(1)];
        case 0x07:
          return [{ type: "undefined", value: undefined }, stream.slice(1)];
        case 0x09:
        case 0x0a:
        case 0x0b:
          return _parseFloat(stream);
      }
    default:
      throw "Unknown type byte: " + stream[0].toString(16);
  }
}

function _parseUInt(stream: Uint8Array): [CBORItem_<"uint">, Uint8Array] {
  let [n, stream_] = _parseBigInt("uint", stream);
  return [{ type: "uint", ...n }, stream_];
}

function _parseNegInt(stream: Uint8Array): [CBORItem_<"nint">, Uint8Array] {
  let [n, stream_] = _parseBigInt("nint", stream);
  n.value = -1n - n.value;
  return [{ type: "nint", ...n }, stream_];
}

function __parseByteString(
  schema: CBORItem["type"],
  stream: Uint8Array
): [CBORItem_<"bstr">, Uint8Array] {
  let tag = stream[0];

  let len = tag & 0b11111;

  if (!((len >= 0x00 && len <= 0x1b) || len == 0x1f)) {
    error(schema, tag);
  }

  if (len == 0x1f) {
    stream = stream.slice(1);

    let chunks: Uint8Array[] = [];
    let chunk: CBORItem & { type: "bstr" };
    let sizes: [number, SizeBytes][] = [];
    while (stream[0] != 0xff) {
      [chunk, stream] = __parseByteString(schema, stream);
      chunks.push(chunk.value);
      if (chunk.size instanceof Array) {
        // In case of a malformed bstr where there are indefinite bstrs
        // nested inside an indefinite bstr, we convert it to an indifinite
        // list of definite length bstrs, where the chunk's size byte is
        // the maximum (8).
        sizes.push([chunk.value.length, 8]);
      } else {
        sizes.push([chunk.value.length, chunk.size]);
      }
    }
    return [{ type: "bstr", size: sizes, value: _mergeChunks(chunks) }, stream];
  } else {
    let n: { size: SizeBytes; value: bigint };
    [n, stream] = _parseBigInt(schema, stream);

    let n_ = bigintToNum(n.value);
    let buffer = stream.slice(0, n_);
    stream = stream.slice(n_);

    return [{ type: "bstr", size: n.size, value: buffer }, stream];
  }
}

function _parseByteString(stream: Uint8Array): [CBORItem_<"bstr">, Uint8Array] {
  return __parseByteString("bstr", stream);
}

function _parseTextString(stream: Uint8Array): [CBORItem_<"tstr">, Uint8Array] {
  let bytes: CBORItem_<"bstr">;
  [bytes, stream] = __parseByteString("tstr", stream);

  let str = new TextDecoder().decode(bytes.value);
  return [{ type: "tstr", size: bytes.size, value: str }, stream];
}

function _parseArray(stream: Uint8Array): [CBORItem_<"array">, Uint8Array] {
  let tag = stream[0];

  let len = tag & 0b11111;

  if (!((len >= 0x00 && len <= 0x1b) || len == 0x1f)) {
    error("array", tag);
  }

  let array: CBORItem[] = [];
  let item: CBORItem;
  let size: SizeBytes | null = null;

  if (len == 0x1f) {
    stream = stream.slice(1);

    while (stream[0] != 0xff) {
      [item, stream] = parse(stream);
      array.push(item);
    }
  } else {
    let n;
    [n, stream] = _parseBigInt("array", stream);

    let n_ = bigintToNum(n.value);
    size = n.size;

    for (let i = 0; i < n_; i++) {
      [item, stream] = parse(stream);
      array.push(item);
    }
  }

  return [{ type: "array", size, value: array }, stream];
}

function _parseMap(stream: Uint8Array): [CBORItem_<"map">, Uint8Array] {
  let tag = stream[0];

  let len = tag & 0b11111;

  if (!((len >= 0x00 && len <= 0x1b) || len == 0x1f)) {
    error("map", tag);
  }

  let map: [CBORItem, CBORItem][] = [];
  let size: SizeBytes | null = null;
  let key: CBORItem;
  let val: CBORItem;

  if (len == 0x1f) {
    stream = stream.slice(1);

    while (stream[0] != 0xff) {
      [key, stream] = parse(stream);
      [val, stream] = parse(stream);
      map.push([key, val]);
    }
  } else {
    let n;
    [n, stream] = _parseBigInt("map", stream);

    let n_ = bigintToNum(n.value);
    size = n.size;

    for (let i = 0; i < n_; i++) {
      [key, stream] = parse(stream);
      [val, stream] = parse(stream);
      map.push([key, val]);
    }
  }

  return [{ type: "map", size, value: map }, stream];
}

function _parseFloat(stream: Uint8Array): [CBORItem_<"float">, Uint8Array] {
  let view = new DataView(stream.buffer);
  switch (stream[0]) {
    case 0xf9:
      throw "Half-precision floats are unsupported"; // TODO: Get the bytes and reconstruct manually
    case 0xfa:
      return [
        { type: "float", size: 4, value: view.getFloat32(1, false) },
        stream.slice(5),
      ];
    case 0xfb:
      return [
        { type: "float", size: 8, value: view.getFloat64(1, false) },
        stream.slice(9),
      ];
    default:
      throw "Unreachable";
  }
}

function _parseTagged(stream: Uint8Array): [CBORItem_<"tagged">, Uint8Array] {
  let tag = stream[0];
  stream = stream.slice(1);

  let tagValue = tag & 0b11111;
  let inner: CBORItem;
  [inner, stream] = parse(stream);
  return [
    {
      type: "tagged",
      tag: tagValue,
      value: inner,
    },
    stream,
  ];
}

function _mergeChunks(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  chunks.forEach((item) => {
    length += item.length;
  });

  let merged = new Uint8Array(length);

  let offset = 0;
  chunks.forEach((item) => {
    merged.set(item, offset);
    offset += item.length;
  });

  return merged;
}

function _parseBigInt(
  schema: CBORItem["type"],
  stream: Uint8Array
): [{ size: SizeBytes; value: bigint }, Uint8Array] {
  let tag = stream[0];
  stream = stream.slice(1);

  let len = tag & 0b11111;

  // the value of the length field must be between 0x00 and 0x1b
  if (!(len >= 0x00 && len <= 0x1b)) {
    error(schema, tag);
  }

  // if the length field is less than 0x18, then that itself is the value
  // (optimization for small values)
  if (len < 0x18) {
    return [{ size: 0, value: BigInt(len) }, stream];
  }

  // Else the length is 2^(length - 0x18)
  let nBytes = Math.pow(2, len - 0x18);

  return [
    {
      size: nBytes as SizeBytes,
      value: readBigInt(nBytes, stream),
    },
    stream.slice(nBytes),
  ];
}

function readBigInt(nBytes: number, stream: Uint8Array): bigint {
  let x = BigInt(0);
  for (let i = 0; i < nBytes; i++) {
    x = x << 8n;
    x += BigInt(stream[i]);
  }
  return x;
}

function error(expected: CBORItem["type"], received: number) {
  throw `Expected ${expected}. Received: ${received.toString(16)}`;
}

function bigintToNum(x: bigint): number {
  return Number(x);
}

export { parse, CBORItem, CBORItem_ };