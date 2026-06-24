const ESC_BYTE = 0x1b;
const SERIAL_STRING_CONTROL_MARKER = 0x3f; // "?"

export class SerialConsoleIngress {
  private pendingEscape = false;

  filter(bytes: Uint8Array): Uint8Array {
    if (bytes.length === 0) {
      return bytes;
    }

    const filtered: number[] = [];
    let index = 0;
    if (this.pendingEscape) {
      this.pendingEscape = false;
      appendSerialEscapePair(filtered, bytes[0]);
      index = 1;
    }

    while (index < bytes.length) {
      const byte = bytes[index];
      if (byte !== ESC_BYTE) {
        filtered.push(byte);
        index += 1;
        continue;
      }

      const next = bytes[index + 1];
      if (next === undefined) {
        // Serial reads can split an escape sequence across chunks.
        this.pendingEscape = true;
        break;
      }

      appendSerialEscapePair(filtered, next);
      index += 2;
    }

    return Uint8Array.from(filtered);
  }

  reset(): void {
    this.pendingEscape = false;
  }
}

function appendSerialEscapePair(output: number[], next: number): void {
  if (isTerminalStringControl(next)) {
    // Raw serial boot noise can contain unterminated terminal string controls.
    // Passing them to xterm can hide every later printable byte.
    output.push(SERIAL_STRING_CONTROL_MARKER);
    return;
  }

  output.push(ESC_BYTE, next);
}

function isTerminalStringControl(byte: number): boolean {
  return byte === 0x5d // OSC: ESC ]
    || byte === 0x50 // DCS: ESC P
    || byte === 0x5f // APC: ESC _
    || byte === 0x5e // PM: ESC ^
    || byte === 0x58; // SOS: ESC X
}
