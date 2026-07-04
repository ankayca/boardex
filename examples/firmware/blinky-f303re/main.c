/*
 * Minimal bare-metal blinky for the NUCLEO-F303RE.
 *
 * Purpose: a zero-dependency firmware to validate Boardex's flash path
 * (boardex-target -> pyOCD -> ST-Link -> STM32F303RE). It blinks the onboard
 * user LED LD2, which is wired to PA5.
 *
 * No HAL, no libc: just enough startup to run main(). For real project
 * firmware we intend to use Zephyr (ztest/twister + RTT logging).
 */

#include <stdint.h>

/* --- register map (STM32F303xE reference manual RM0316) --------------- */
#define RCC_BASE 0x40021000UL
#define GPIOA_BASE 0x48000000UL

#define RCC_AHBENR (*(volatile uint32_t *)(RCC_BASE + 0x14))
#define GPIOA_MODER (*(volatile uint32_t *)(GPIOA_BASE + 0x00))
#define GPIOA_ODR (*(volatile uint32_t *)(GPIOA_BASE + 0x14))

#define RCC_AHBENR_IOPAEN (1U << 17) /* GPIOA clock enable */
#define LED_PIN 5                     /* LD2 = PA5 */

/* Symbols provided by the linker script. */
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss, _estack;

int main(void);
void Reset_Handler(void);
void Default_Handler(void);

/* Minimal Cortex-M vector table: initial stack pointer + core handlers. */
__attribute__((section(".isr_vector"), used))
void (*const vector_table[])(void) = {
    (void (*)(void))(&_estack), /* initial stack pointer            */
    Reset_Handler,              /* Reset                            */
    Default_Handler,            /* NMI                              */
    Default_Handler,            /* HardFault                        */
};

void Reset_Handler(void) {
    /* Copy initialised data from flash to RAM. */
    uint32_t *src = &_sidata;
    for (uint32_t *dst = &_sdata; dst < &_edata;) {
        *dst++ = *src++;
    }
    /* Zero the .bss section. */
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

    /* PA5 -> general purpose output (MODER5 = 0b01). */
    GPIOA_MODER &= ~(3U << (LED_PIN * 2));
    GPIOA_MODER |= (1U << (LED_PIN * 2));

    for (;;) {
        GPIOA_ODR ^= (1U << LED_PIN);
        delay(400000);
    }
}
