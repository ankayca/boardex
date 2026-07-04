# Minimal bare-metal build for the NUCLEO-F303RE blinky.
#
# Uses whatever arm-none-eabi toolchain is on PATH. If you installed a local
# toolchain, prepend its bin/ to PATH or override CROSS, e.g.:
#   make CROSS=/path/to/arm-gnu-toolchain/bin/arm-none-eabi-

CROSS  ?= arm-none-eabi-
CC      = $(CROSS)gcc
OBJCOPY = $(CROSS)objcopy

TARGET = blinky-f303re

CFLAGS  = -mcpu=cortex-m4 -mthumb -mfloat-abi=soft \
          -Wall -Wextra -O2 -ffreestanding -nostdlib -std=c11
LDFLAGS = -T linker.ld -nostdlib -Wl,--gc-sections

all: $(TARGET).elf $(TARGET).bin

$(TARGET).elf: main.c linker.ld
	$(CC) $(CFLAGS) $(LDFLAGS) main.c -o $@

$(TARGET).bin: $(TARGET).elf
	$(OBJCOPY) -O binary $< $@

clean:
	rm -f $(TARGET).elf $(TARGET).bin

.PHONY: all clean
