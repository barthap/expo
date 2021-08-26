#include <jni.h>
#include "example.h"

extern "C"
JNIEXPORT jint JNICALL
Java_expo_modules_sweetsqlite_NativeWrapper_nativeMultiply(JNIEnv *env, jclass clazz, jint a,
                                                           jint b) {
    return example::multiply(a, b);
}