/*
 * NUCLEO-F303RE firmware that blinks LD2 (PA5) *and* streams text over SEGGER
 * RTT, used to validate Boardex's read_firmware_log tool.
 *
 * The RTT control block below is a clean-room, minimal implementation that is
 * binary-compatible with what pyOCD's RTT reader expects (a 16-byte "SEGGER RTT"
 * id, up/down buffer counts, then up/down ring-buffer descriptors). This avoids
 * pulling in SEGGER's licensed sources. Only a single up channel is implemented.
 */

#include <stdint.h>

/* --- registers (STM32F303xE) ----------------------------------------- */
#define RCC_BASE 0x40021000UL
#define GPIOA_BASE 0x48000000UL
#define RCC_AHBENR (*(volatile uint32_t *)(RCC_BASE + 0x14))
#define GPIOA_MODER (*(volatile uint32_t *)(GPIOA_BASE + 0x00))
#define GPIOA_ODR (*(volatile uint32_t *)(GPIOA_BASE + 0x14))
#define RCC_AHBENR_IOPAEN (1U << 17)
#define LED_PIN 5

/* --- minimal SEGGER-RTT-compatible control block --------------------- */
#define RTT_UP_SIZE 1024
static volatile unsigned char rtt_up_storage[RTT_UP_SIZE];

typedef struct {
    const char *sName;
    unsigned char *pBuffer;
    unsigned SizeOfBuffer;
    unsigned WrOff; /* written by target */
    unsigned RdOff; /* written by host   */
    unsigned Flags;
} rtt_buffer_t;

typedef struct {
    char acID[16];
    int MaxNumUpBuffers;
    int MaxNumDownBuffers;
    rtt_buffer_t aUp[1];
    rtt_buffer_t aDown[1];
} rtt_cb_t;

/* 'used' + mutable so it lives in RAM (.data) and survives -O2 gc. The host
 * finds it by scanning RAM for the "SEGGER RTT" id string. */
rtt_cb_t _SEGGER_RTT __attribute__((used)) = {
    .acID = "SEGGER RTT",
    .MaxNumUpBuffers = 1,
    .MaxNumDownBuffers = 1,
    .aUp = {{
        .sName = "Terminal",
        .pBuffer = (unsigned char *)rtt_up_storage,
        .SizeOfBuffer = RTT_UP_SIZE,
        .WrOff = 0,
        .RdOff = 0,
        .Flags = 0,
    }},
    .aDown = {{0}},
};

static void rtt_write(const char *s) {
    volatile rtt_buffer_t *up = &_SEGGER_RTT.aUp[0];
    volatile unsigned char *buf = up->pBuffer;
    while (*s) {
        unsigned wr = up->WrOff;
        unsigned next = wr + 1;
        if (next >= up->SizeOfBuffer) {
            next = 0;
        }
        if (next == up->RdOff) {
            break; /* buffer full: drop the rest */
        }
        buf[wr] = (unsigned char)*s++;
        up->WrOff = next;
    }
}

static void rtt_write_uint(unsigned value) {
    char tmp[12];
    int i = (int)sizeof(tmp) - 1;
    tmp[i--] = '\0';
    if (value == 0) {
        tmp[i--] = '0';
    }
    while (value != 0 && i >= 0) {
        tmp[i--] = (char)('0' + (value % 10));
        value /= 10;
    }
    rtt_write(&tmp[i + 1]);
}

/* --- startup --------------------------------------------------------- */
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss, _estack;

int main(void);
void Reset_Handler(void);
void Default_Handler(void);

__attribute__((section(".isr_vector"), used))
void (*const vector_table[])(void) = {
    (void (*)(void))(&_estack),
    Reset_Handler,
    Default_Handler,
    Default_Handler,
};

void Reset_Handler(void) {
    uint32_t *src = &_sidata;
    for (uint32_t *dst = &_sdata; dst < &_edata;) {
        *dst++ = *src++;
    }
    for (uint32_t *dst = &_sbss; dst < &_ebss;) {
        *dst++ = 0;
    }
    main();
    for (;;) {
    }
}

void Default_Handler(void) {
    for (;;) {
    }
}

static void delay(volatile uint32_t count) {
    while (count--) {
        __asm__ volatile("nop");
    }
}

int main(void) {
    RCC_AHBENR |= RCC_AHBENR_IOPAEN;
    GPIOA_MODER &= ~(3U << (LED_PIN * 2));
    GPIOA_MODER |= (1U << (LED_PIN * 2));

    rtt_write("Boardex RTT online\n");

    unsigned tick = 0;
    for (;;) {
        GPIOA_ODR ^= (1U << LED_PIN);
        rtt_write("tick ");
        rtt_write_uint(tick++);
        rtt_write("\n");
        delay(800000);
    }
}
