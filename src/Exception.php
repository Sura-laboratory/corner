<?php

declare(strict_types=1);

namespace Sura\Corner;

/**
 * Class Exception.
 */
class Exception extends \Exception implements CornerInterface
{
    use CornerTrait;
}
