# Bare-metal build for the NUCLEO-F303RE RTT demo (blink + RTT logging).
#
#   make                                                # toolchain on PATH
#   make CROSS=/path/to/toolchain/bin/arm-none-eabi-    # explicit toolchain

CROSS  ?= arm-none-eabi-
CC      = $(CROSS)gcc
OBJCOPY = $(CROSS)objcopy

TARGET = rtt-f303re

CFLAGS  = -mcpu=cortex-m4 -mthumb -mfloat-abi=soft \
          -Wall -Wextra -O2 -g -ffreestanding -nostdlib -std=c11
LDFLAGS = -T linker.ld -nostdlib -Wl,--gc-sections

all: $(TARGET).elf $(TARGET).bin

$(TARGET).elf: main.c linker.ld
	$(CC) $(CFLAGS) $(LDFLAGS) main.c -o $@

$(TARGET).bin: $(TARGET).elf
	$(OBJCOPY) -O binary $< $@

clean:
	rm -f $(TARGET).elf $(TARGET).bin

.PHONY: all clean
